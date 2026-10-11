import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildChannels,
  classifyRecordType,
  dailyDistributionXml,
  errorFor,
  liveUrl,
  matchesToReview,
  mergeSegments,
  parseDailyDistribution,
  parseDeviceClock,
  parseDeviceInfo,
  parseHikTime,
  parseInputProxyChannels,
  parseInputProxyStatus,
  parsePtzCaps,
  parsePtzPresets,
  parseRtspPort,
  parseSearchResult,
  parseStreamingChannels,
  parseVideoInputs,
  playbackUrl,
  ptzXml,
  rtspTime,
  searchTime,
  searchXml,
  xmlBlocks,
  xmlText,
  type DeviceClock,
} from '../src/systems/hikvision-parse.ts';

const CEST: DeviceClock = { offsetMin: 120, phoneZone: false };

// Payloads below follow real device responses captured in hikvision_next's test fixtures
// (DS-7608NXI-I2 NVR, iDS-7204HUHI-M1 DVR, DS-2SE4C425MWG-E IP dome).

const NVR_INFO = `<?xml version="1.0" encoding="UTF-8"?>
<DeviceInfo version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema">
<deviceName>nvr</deviceName>
<deviceID>484a3831-3130-0000-0000-000c0000f00e</deviceID>
<model>DS-7608NXI-I2/8P/S</model>
<serialNumber>DS-7608NXI-I0/0P/S0000000000CCRRJ00000000WCVU</serialNumber>
<firmwareVersion>V4.62.210</firmwareVersion>
<deviceType>NVR</deviceType>
</DeviceInfo>`;

const PROXY = `<?xml version="1.0" encoding="UTF-8"?>
<InputProxyChannelList version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema" size="4">
<InputProxyChannel version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema">
<id>1</id>
<name>garden</name>
<sourceInputPortDescriptor>
<proxyProtocol>HIKVISION</proxyProtocol>
<addressingFormatType>ipaddress</addressingFormatType>
<ipAddress>192.168.254.2</ipAddress>
<managePortNo>8000</managePortNo>
<srcInputPort>1</srcInputPort>
<userName>admin</userName>
<model>DS-2CD2386G2-IU</model>
</sourceInputPortDescriptor>
<enableTiming>true</enableTiming>
</InputProxyChannel>
<InputProxyChannel version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema">
<id>2</id>
<name>Back &amp; Side</name>
<sourceInputPortDescriptor><srcInputPort>1</srcInputPort></sourceInputPortDescriptor>
</InputProxyChannel>
</InputProxyChannelList>`;

const PROXY_STATUS = `<InputProxyChannelStatusList version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema">
<InputProxyChannelStatus><id>1</id><sourceInputPortDescriptor><ipAddress>192.168.254.2</ipAddress></sourceInputPortDescriptor><online>true</online></InputProxyChannelStatus>
<InputProxyChannelStatus><id>2</id><online>false</online><chanDetectResult>offline</chanDetectResult></InputProxyChannelStatus>
</InputProxyChannelStatusList>`;

const STREAMS = `<StreamingChannelList version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema">
<StreamingChannel version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema">
<id>101</id><channelName>garden</channelName><enabled>true</enabled>
<Transport><ControlProtocolList><ControlProtocol><streamingTransport>RTSP</streamingTransport></ControlProtocol></ControlProtocolList></Transport>
<Video><enabled>true</enabled><videoInputChannelID>1</videoInputChannelID><videoCodecType>H.264</videoCodecType><videoResolutionWidth>3840</videoResolutionWidth><videoResolutionHeight>2160</videoResolutionHeight></Video>
</StreamingChannel>
<StreamingChannel version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema">
<id>102</id><channelName>garden</channelName><enabled>true</enabled>
<Video><videoInputChannelID>1</videoInputChannelID><videoResolutionWidth>640</videoResolutionWidth><videoResolutionHeight>360</videoResolutionHeight></Video>
</StreamingChannel>
</StreamingChannelList>`;

test('xml helpers: blocks, text, entities, prefixes, self-closing', () => {
  assert.deepEqual(xmlBlocks('<a><b>1</b><b x="y">2</b><b/></a>', 'b'), ['1', '2', '']);
  assert.equal(xmlText('<x:name>Tom &amp; Jerry</x:name>', 'name'), 'Tom & Jerry');
  assert.equal(xmlText('<dayList><day><id>1</id></day></dayList>', 'day'), '<id>1</id>');
  assert.equal(xmlText('<a/>', 'b'), undefined);
});

test('device info and NVR channels with names, status and resolution', () => {
  const dev = parseDeviceInfo(NVR_INFO);
  assert.deepEqual(dev, { name: 'nvr', model: 'DS-7608NXI-I2/8P/S', deviceType: 'NVR' });
  assert.throws(() => parseDeviceInfo('<html>hello</html>'), /doesn’t seem to be a Hikvision device/);

  const chans = buildChannels({
    device: dev,
    proxy: parseInputProxyChannels(PROXY),
    proxyStatus: parseInputProxyStatus(PROXY_STATUS),
    inputs: [],
    streams: parseStreamingChannels(STREAMS),
  });
  assert.deepEqual(chans, [
    { id: 1, name: 'garden', online: true, proxied: true, width: 3840, height: 2160 },
    { id: 2, name: 'Back & Side', online: false, proxied: true, width: undefined, height: undefined },
  ]);
});

test('DVR analog inputs skip unused "NO VIDEO" inputs; a camera uses its own name', () => {
  const inputs = parseVideoInputs(`<VideoInputChannelList version="1.0" xmlns="http://www.hikvision.com/ver20/XMLSchema">
<VideoInputChannel version="1.0"><id>1</id><inputPort>1</inputPort><videoInputEnabled>true</videoInputEnabled><name>Entrada</name><videoFormat>PAL</videoFormat><resDesc>2560*1440(4MP)P30</resDesc></VideoInputChannel>
<VideoInputChannel version="1.0"><id>2</id><inputPort>2</inputPort><videoInputEnabled>true</videoInputEnabled><name>Camera 02</name><resDesc>NO VIDEO</resDesc></VideoInputChannel>
<VideoInputChannel version="1.0"><id>3</id><inputPort>3</inputPort><videoInputEnabled>true</videoInputEnabled><name>Terraza - Taller</name><resDesc>2560*1440(4MP)P25</resDesc></VideoInputChannel>
</VideoInputChannelList>`);
  const dvr = buildChannels({
    device: { name: 'Embedded Net DVR', model: 'iDS-7204HUHI-M1/E', deviceType: 'DVR' },
    proxy: [],
    proxyStatus: new Map(),
    inputs,
    streams: [],
  });
  assert.deepEqual(dvr.map((c) => [c.id, c.name]), [
    [1, 'Entrada'],
    [3, 'Terraza - Taller'],
  ]);

  const cam = buildChannels({
    device: { name: 'Front Porch', model: 'DS-2CD2386G2-IU', deviceType: 'IPCamera' },
    proxy: [],
    proxyStatus: new Map(),
    inputs: [],
    streams: parseStreamingChannels(STREAMS),
  });
  assert.deepEqual(cam.map((c) => [c.id, c.name, c.width]), [[1, 'Front Porch', 3840]]);
});

test('RTSP port and live URLs', () => {
  const access = `<AdminAccessProtocolList><AdminAccessProtocol><id>1</id><enabled>true</enabled><protocol>HTTP</protocol><portNo>80</portNo></AdminAccessProtocol>
<AdminAccessProtocol><id>2</id><enabled>true</enabled><protocol>RTSP</protocol><portNo>10554</portNo></AdminAccessProtocol></AdminAccessProtocolList>`;
  assert.equal(parseRtspPort(access), 10554);
  assert.equal(parseRtspPort('<AdminAccessProtocolList/>'), 554);
  assert.equal(
    liveUrl({ host: '192.168.1.64', port: 554, user: 'admin', password: 'Pa$$:word@1', channel: 3, quality: 'sub' }),
    'rtsp://admin:Pa%24%24%3Aword%401@192.168.1.64:554/Streaming/Channels/302',
  );
});

test('device clock and "fake Z" local times', () => {
  const clock = parseDeviceClock('<Time><timeMode>NTP</timeMode><localTime>2024-07-01T12:00:00+02:00</localTime><timeZone>CST-1:00:00DST</timeZone></Time>', 0, -300);
  assert.deepEqual(clock, { offsetMin: 120, phoneZone: false });
  const noOffset = parseDeviceClock('<Time><localTime>2024-07-01T12:00:05</localTime></Time>', Date.UTC(2024, 6, 1, 10, 0, 0), 120);
  assert.deepEqual(noOffset, { offsetMin: 120, phoneZone: true });

  const t = Date.UTC(2024, 6, 1, 10, 0, 0) / 1000; // 12:00 at the device
  assert.equal(parseHikTime('2024-07-01T12:00:00Z', CEST), t);
  assert.equal(parseHikTime('2024-07-01T12:00:00+02:00', CEST), t);
  assert.equal(parseHikTime('20240701T120000Z', CEST), t);
  assert.equal(searchTime(t, CEST), '2024-07-01T12:00:00Z');
  assert.equal(rtspTime(t, CEST), '20240701T120000Z');
  assert.equal(parseHikTime('garbage', CEST), null);
});

test('playback URL uses the main track with device-local start and end', () => {
  const start = Date.UTC(2024, 6, 1, 10, 0, 0) / 1000;
  assert.equal(
    playbackUrl({ host: '192.168.1.64', port: 554, user: 'admin', password: 'pw', channel: 2, start, end: start + 1800, clock: CEST }),
    'rtsp://admin:pw@192.168.1.64:554/Streaming/tracks/201?starttime=20240701T120000Z&endtime=20240701T123000Z',
  );
});

test('search request and result parsing, including paging and event types', () => {
  const body = searchXml({ searchId: 'ABC', track: 101, start: Date.UTC(2024, 6, 1, 10) / 1000, end: Date.UTC(2024, 6, 1, 11) / 1000, clock: CEST, position: 50, maxResults: 50, metadata: 'AllEvent' });
  assert.match(body, /<trackID>101<\/trackID>/);
  assert.match(body, /<startTime>2024-07-01T12:00:00Z<\/startTime><endTime>2024-07-01T13:00:00Z<\/endTime>/);
  assert.match(body, /<searchResultPostion>50<\/searchResultPostion>/);
  assert.match(body, /<metadataDescriptor>\/\/recordType\.meta\.std-cgi\.com\/AllEvent<\/metadataDescriptor>/);

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<CMSearchResult version="2.0" xmlns="http://www.hikvision.com/ver20/XMLSchema">
<searchID>{ABC}</searchID>
<responseStatus>true</responseStatus>
<responseStatusStrg>MORE</responseStatusStrg>
<numOfMatches>3</numOfMatches>
<matchList>
<searchMatchItem>
<sourceID>{0000000000-0000-0000-0000-000000000000}</sourceID>
<trackID>101</trackID>
<timeSpan><startTime>2024-07-01T12:00:00Z</startTime><endTime>2024-07-01T12:10:00Z</endTime></timeSpan>
<mediaSegmentDescriptor><contentType>video</contentType><codecType>H.264-BP</codecType>
<playbackURI>rtsp://192.168.1.64/Streaming/tracks/101/?starttime=20240701T120000Z&amp;endtime=20240701T121000Z&amp;name=00000000226000000&amp;size=262144000</playbackURI>
</mediaSegmentDescriptor>
<metadataMatches><metadataDescriptor>recordType.meta.std-cgi.com/CMR</metadataDescriptor></metadataMatches>
</searchMatchItem>
<searchMatchItem>
<trackID>101</trackID>
<timeSpan><startTime>2024-07-01T12:10:00Z</startTime><endTime>2024-07-01T12:11:30Z</endTime></timeSpan>
<mediaSegmentDescriptor><playbackURI>rtsp://192.168.1.64/Streaming/tracks/101/?starttime=20240701T121000Z</playbackURI></mediaSegmentDescriptor>
<metadataMatches><metadataDescriptor>recordType.meta.std-cgi.com/VMD</metadataDescriptor></metadataMatches>
</searchMatchItem>
<searchMatchItem>
<trackID>101</trackID>
<timeSpan><startTime>2024-07-01T12:30:00Z</startTime><endTime>2024-07-01T12:31:00Z</endTime></timeSpan>
<metadataMatches><metadataDescriptor>recordType.meta.std-cgi.com/lineDetection</metadataDescriptor></metadataMatches>
</searchMatchItem>
</matchList>
</CMSearchResult>`;
  const page = parseSearchResult(xml, CEST);
  assert.equal(page.more, true);
  assert.equal(page.matches.length, 3);
  assert.equal(page.matches[0].start, Date.UTC(2024, 6, 1, 10, 0, 0) / 1000);
  assert.match(page.matches[0].playbackUri, /&endtime=20240701T121000Z&name=/);

  const segs = mergeSegments(page.matches);
  assert.equal(segs.length, 2);
  assert.equal(segs[0].end - segs[0].start, 690);

  const review = matchesToReview(page.matches, 'sys', '1');
  assert.deepEqual(review.map((r) => [r.severity, r.objects]), [
    ['detection', []],
    ['alert', []],
  ]);

  const none = parseSearchResult('<CMSearchResult><responseStatus>false</responseStatus><responseStatusStrg>NO MATCHES</responseStatusStrg><numOfMatches>0</numOfMatches></CMSearchResult>', CEST);
  assert.deepEqual(none, { matches: [], more: false });
});

test('record types: continuous is not an event; AcuSense types name the object', () => {
  assert.equal(classifyRecordType('recordType.meta.std-cgi.com/CMR'), null);
  assert.equal(classifyRecordType('recordType.meta.hikvision.com/timing'), null);
  assert.deepEqual(classifyRecordType('recordType.meta.hikvision.com/motion'), { objects: [], severity: 'detection' });
  assert.deepEqual(classifyRecordType('recordType.meta.std-cgi.com/humanDetection'), { objects: ['person'], severity: 'alert' });
  assert.deepEqual(classifyRecordType('recordType.meta.std-cgi.com/vehicleDetection'), { objects: ['vehicle'], severity: 'alert' });
  assert.deepEqual(classifyRecordType('recordType.meta.std-cgi.com/fieldDetection'), { objects: [], severity: 'alert' });
  assert.deepEqual(classifyRecordType(''), { objects: [], severity: 'detection' });
});

test('daily distribution → recording days', () => {
  assert.match(dailyDistributionXml(2024, 7), /<year>2024<\/year><monthOfYear>7<\/monthOfYear>/);
  const xml = `<trackDailyDistribution version="2.0" xmlns="http://www.hikvision.com/ver20/XMLSchema"><dayList>
<day><id>1</id><dayOfMonth>1</dayOfMonth><record>true</record><recordType>time</recordType></day>
<day><id>2</id><dayOfMonth>2</dayOfMonth><record>false</record></day>
<day><id>3</id><dayOfMonth>3</dayOfMonth><record>true</record><recordType>event</recordType></day>
</dayList></trackDailyDistribution>`;
  assert.deepEqual(parseDailyDistribution(xml, 2024, 7), ['2024-07-01', '2024-07-03']);
});

test('PTZ: capabilities, presets, continuous move bodies', () => {
  const caps = `<PTZChanelCap version="2.0"><AbsolutePanTiltPositionSpace><XRange><Min>0</Min><Max>3600</Max></XRange></AbsolutePanTiltPositionSpace>
<ContinuousPanTiltSpace><XRange><Min>-100</Min><Max>100</Max></XRange></ContinuousPanTiltSpace><ContinuousZoomSpace><XRange><Min>-100</Min><Max>100</Max></XRange></ContinuousZoomSpace></PTZChanelCap>`;
  assert.deepEqual(parsePtzCaps(caps), { canMove: true, canZoom: true });
  assert.deepEqual(parsePtzCaps('<PTZChanelCap><ContinuousZoomSpace></ContinuousZoomSpace></PTZChanelCap>'), { canMove: false, canZoom: true });
  assert.deepEqual(parsePtzCaps(''), { canMove: false, canZoom: false });

  const presets = `<PTZPresetList version="2.0">
<PTZPreset><enabled>true</enabled><id>1</id><presetName>Driveway</presetName></PTZPreset>
<PTZPreset><enabled>false</enabled><id>2</id><presetName>Preset 2</presetName></PTZPreset>
<PTZPreset><id>3</id><presetName>Gate</presetName></PTZPreset>
</PTZPresetList>`;
  assert.deepEqual([...parsePtzPresets(presets)], [['Driveway', 1], ['Gate', 3]]);

  assert.match(ptzXml('MOVE_LEFT')!, /<pan>-60<\/pan><tilt>0<\/tilt><zoom>0<\/zoom>/);
  assert.match(ptzXml('ZOOM_IN')!, /<zoom>60<\/zoom>/);
  assert.match(ptzXml('STOP')!, /<pan>0<\/pan><tilt>0<\/tilt><zoom>0<\/zoom>/);
  assert.equal(ptzXml('preset_x'), null);
});

test('errors are plain language', () => {
  assert.match(errorFor(401, '').message, /rejected the username or password/);
  assert.match(errorFor(403, '').message, /admin account/);
  const notSupported = errorFor(400, '<ResponseStatus><statusCode>4</statusCode><statusString>Invalid Operation</statusString><subStatusCode>notSupport</subStatusCode></ResponseStatus>');
  assert.equal(notSupported.notSupported, true);
  assert.match(errorFor(502, 'gateway: dial tcp: i/o timeout').message, /Couldn’t reach/);
});
