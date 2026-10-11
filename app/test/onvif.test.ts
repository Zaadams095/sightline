import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import {
  base64,
  body,
  camerasFromProfiles,
  deviceName,
  elements,
  envelope,
  faultMessage,
  isAuthFault,
  onvifTimestamp,
  parseCapabilities,
  parseDeviceInfo,
  parseFault,
  parseProfiles,
  parsePresets,
  parsePtzNodes,
  parseServices,
  parseSystemTime,
  parseUri,
  passwordDigest,
  securityHeader,
  shouldRewriteHost,
  snapshotUrl,
  streamUrl,
  xaddrPath,
} from '../src/systems/onvif-soap.ts';

const sha1 = async (b: Uint8Array) => new Uint8Array(createHash('sha1').update(b).digest());
const fromB64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));

const wrap = (inner: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>
<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://www.w3.org/2003/05/soap-envelope" xmlns:tt="http://www.onvif.org/ver10/schema" xmlns:trt="http://www.onvif.org/ver10/media/wsdl" xmlns:tds="http://www.onvif.org/ver10/device/wsdl" xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl" xmlns:ter="http://www.onvif.org/ver10/error">
<SOAP-ENV:Header></SOAP-ENV:Header>
<SOAP-ENV:Body>${inner}</SOAP-ENV:Body>
</SOAP-ENV:Envelope>`;

test('WS-Security PasswordDigest matches the ONVIF programmer guide vector', async () => {
  const digest = await passwordDigest(fromB64('LKqI6G/AikKCQrN0zqZFlg=='), '2010-09-16T07:50:45Z', 'userpassword', sha1);
  assert.equal(digest, 'tuOSpGlFlIXsozq4HFNeeGeFLEI=');
});

test('PasswordDigest hashes raw nonce bytes (not their base64 text)', async () => {
  const nonce = new Uint8Array([0, 255, 1, 128, 7, 200, 13, 10, 0, 0, 99, 42, 250, 251, 252, 253]);
  const expected = createHash('sha1')
    .update(Buffer.concat([Buffer.from(nonce), Buffer.from('2026-01-02T03:04:05Z'), Buffer.from('pä$$wörd')]))
    .digest('base64');
  assert.equal(await passwordDigest(nonce, '2026-01-02T03:04:05Z', 'pä$$wörd', sha1), expected);
});

test('base64 matches Node for all padding lengths', () => {
  for (let n = 0; n < 10; n++) {
    const b = new Uint8Array(n).map((_, i) => (i * 37 + 250) & 255);
    assert.equal(base64(b), Buffer.from(b).toString('base64'));
  }
});

test('security header and envelope', async () => {
  const h = await securityHeader({ username: 'ad<min', password: 'x', nonce: new Uint8Array(16), created: onvifTimestamp(0), sha1 });
  assert.match(h, /<wsse:Username>ad&lt;min<\/wsse:Username>/);
  assert.match(h, /<wsu:Created>1970-01-01T00:00:00Z<\/wsu:Created>/);
  assert.match(h, /#PasswordDigest">[A-Za-z0-9+/=]{28}</);
  const env = envelope(body.getProfiles(false), h);
  assert.match(env, /^<\?xml[^>]*\?><s:Envelope [^>]*xmlns:s="http:\/\/www\.w3\.org\/2003\/05\/soap-envelope"/);
  assert.match(env, /<s:Header><wsse:Security[\s\S]*<\/s:Header><s:Body><trt:GetProfiles\/><\/s:Body><\/s:Envelope>$/);
  assert.ok(!envelope('<x/>').includes('Header'));
});

test('element extraction ignores prefixes and handles nesting', () => {
  const xml = '<a:Foo id="1"><b:Foo id="2">x</b:Foo></a:Foo><Foo id="3"/><FooBar>no</FooBar><c:Foo id=\'4\'>y &amp; z</c:Foo>';
  const els = elements(xml, 'Foo');
  assert.deepEqual(els.map((e) => e.attrs.id), ['1', '3', '4']);
  assert.equal(els[0].inner, '<b:Foo id="2">x</b:Foo>');
});

const PROFILES = wrap(`<trt:GetProfilesResponse>
<trt:Profiles token="Profile_1" fixed="true">
  <tt:Name>mainStream</tt:Name>
  <tt:VideoSourceConfiguration token="VideoSourceToken">
    <tt:Name>VideoSourceConfig</tt:Name><tt:UseCount>2</tt:UseCount>
    <tt:SourceToken>VideoSource_1</tt:SourceToken>
    <tt:Bounds x="0" y="0" width="2560" height="1440"></tt:Bounds>
  </tt:VideoSourceConfiguration>
  <tt:AudioSourceConfiguration token="AudioSourceConfigToken"><tt:Name>AudioSourceConfig</tt:Name><tt:SourceToken>AudioSourceChannel</tt:SourceToken></tt:AudioSourceConfiguration>
  <tt:VideoEncoderConfiguration token="VideoEncoderToken_1">
    <tt:Name>VideoEncoder_1</tt:Name><tt:UseCount>1</tt:UseCount>
    <tt:Encoding>H264</tt:Encoding>
    <tt:Resolution><tt:Width>2560</tt:Width><tt:Height>1440</tt:Height></tt:Resolution>
    <tt:Quality>3.000000</tt:Quality>
    <tt:RateControl><tt:FrameRateLimit>20</tt:FrameRateLimit><tt:EncodingInterval>1</tt:EncodingInterval><tt:BitrateLimit>4096</tt:BitrateLimit></tt:RateControl>
  </tt:VideoEncoderConfiguration>
  <tt:PTZConfiguration token="PTZToken">
    <tt:Name>PTZ</tt:Name><tt:UseCount>2</tt:UseCount>
    <tt:NodeToken>PTZNODETOKEN</tt:NodeToken>
    <tt:DefaultContinuousPanTiltVelocitySpace>http://www.onvif.org/ver10/tptz/PanTiltSpaces/VelocityGenericSpace</tt:DefaultContinuousPanTiltVelocitySpace>
  </tt:PTZConfiguration>
</trt:Profiles>
<trt:Profiles token="Profile_2" fixed="true">
  <tt:Name>subStream</tt:Name>
  <tt:VideoSourceConfiguration token="VideoSourceToken"><tt:Name>VideoSourceConfig</tt:Name><tt:SourceToken>VideoSource_1</tt:SourceToken><tt:Bounds x="0" y="0" width="2560" height="1440"/></tt:VideoSourceConfiguration>
  <tt:VideoEncoderConfiguration token="VideoEncoderToken_2"><tt:Name>VideoEncoder_2</tt:Name><tt:Encoding>H264</tt:Encoding><tt:Resolution><tt:Width>640</tt:Width><tt:Height>360</tt:Height></tt:Resolution></tt:VideoEncoderConfiguration>
  <tt:PTZConfiguration token="PTZToken"><tt:Name>PTZ</tt:Name><tt:NodeToken>PTZNODETOKEN</tt:NodeToken></tt:PTZConfiguration>
</trt:Profiles>
<trt:Profiles token="Profile_3" fixed="true">
  <tt:Name>jpeg</tt:Name>
  <tt:VideoSourceConfiguration token="VideoSourceToken"><tt:SourceToken>VideoSource_1</tt:SourceToken></tt:VideoSourceConfiguration>
  <tt:VideoEncoderConfiguration token="VideoEncoderToken_3"><tt:Encoding>JPEG</tt:Encoding><tt:Resolution><tt:Width>320</tt:Width><tt:Height>180</tt:Height></tt:Resolution></tt:VideoEncoderConfiguration>
</trt:Profiles>
<trt:Profiles token="Profile_101" fixed="true">
  <tt:Name>lens2</tt:Name>
  <tt:VideoSourceConfiguration token="VSC2"><tt:SourceToken>VideoSource_2</tt:SourceToken></tt:VideoSourceConfiguration>
  <tt:VideoEncoderConfiguration token="VE4"><tt:Encoding>H265</tt:Encoding><tt:Resolution><tt:Width>1920</tt:Width><tt:Height>1080</tt:Height></tt:Resolution></tt:VideoEncoderConfiguration>
</trt:Profiles>
</trt:GetProfilesResponse>`);

test('GetProfiles: profiles, resolutions, PTZ and cameras per video source', () => {
  const profiles = parseProfiles(PROFILES);
  assert.equal(profiles.length, 4);
  assert.deepEqual(profiles[0], {
    token: 'Profile_1',
    name: 'mainStream',
    sourceToken: 'VideoSource_1',
    encoding: 'H264',
    width: 2560,
    height: 1440,
    ptz: { nodeToken: 'PTZNODETOKEN' },
  });
  assert.equal(profiles[2].encoding, 'JPEG');
  assert.equal(profiles[3].ptz, null);

  const cams = camerasFromProfiles(profiles);
  assert.equal(cams.length, 2);
  assert.equal(cams[0].id, 'VideoSource_1');
  assert.equal(cams[0].main.token, 'Profile_1');
  assert.equal(cams[0].sub.token, 'Profile_2'); // JPEG profile skipped
  assert.equal(cams[0].ptzProfile?.token, 'Profile_1');
  assert.equal(cams[1].id, 'VideoSource_2');
  assert.equal(cams[1].main.token, 'Profile_101');
  assert.equal(cams[1].sub.token, 'Profile_101');
  assert.equal(cams[1].ptzProfile, null);
});

test('GetProfiles (Media2) uses the same parser', () => {
  const xml = wrap(`<tr2:GetProfilesResponse xmlns:tr2="http://www.onvif.org/ver20/media/wsdl">
  <tr2:Profiles token="MainStream" fixed="true"><tr2:Name>MainStream</tr2:Name>
    <tr2:Configurations>
      <tr2:VideoSource token="VideoSourceConfig"><tt:Name>VSC</tt:Name><tt:SourceToken>VideoSource0</tt:SourceToken><tt:Bounds x="0" y="0" width="3840" height="2160"/></tr2:VideoSource>
      <tr2:VideoEncoder token="Main" GovLength="50" Profile="Main"><tt:Name>Main</tt:Name><tt:Encoding>H265</tt:Encoding><tt:Resolution><tt:Width>3840</tt:Width><tt:Height>2160</tt:Height></tt:Resolution></tr2:VideoEncoder>
      <tr2:PTZ token="PtzConf"><tt:Name>PTZ</tt:Name><tt:NodeToken>Node0</tt:NodeToken></tr2:PTZ>
    </tr2:Configurations>
  </tr2:Profiles></tr2:GetProfilesResponse>`);
  const [p] = parseProfiles(xml);
  assert.equal(p.sourceToken, 'VideoSource0');
  assert.equal(p.encoding, 'H265');
  assert.equal(p.width, 3840);
  assert.deepEqual(p.ptz, { nodeToken: 'Node0' });
});

test('GetStreamUri / GetSnapshotUri', () => {
  const xml = wrap(`<trt:GetStreamUriResponse><trt:MediaUri>
    <tt:Uri>rtsp://192.168.1.70:554/cam/realmonitor?channel=1&amp;subtype=0&amp;unicast=true&amp;proto=Onvif</tt:Uri>
    <tt:InvalidAfterConnect>false</tt:InvalidAfterConnect><tt:InvalidAfterReboot>false</tt:InvalidAfterReboot><tt:Timeout>PT0S</tt:Timeout>
  </trt:MediaUri></trt:GetStreamUriResponse>`);
  assert.equal(parseUri(xml), 'rtsp://192.168.1.70:554/cam/realmonitor?channel=1&subtype=0&unicast=true&proto=Onvif');
  const media2 = wrap('<tr2:GetStreamUriResponse xmlns:tr2="http://www.onvif.org/ver20/media/wsdl"><tr2:Uri>rtsp://10.0.0.5/Streaming/Channels/101</tr2:Uri></tr2:GetStreamUriResponse>');
  assert.equal(parseUri(media2), 'rtsp://10.0.0.5/Streaming/Channels/101');
  assert.match(body.getStreamUri('Profile_1', false), /<tt:Stream>RTP-Unicast<\/tt:Stream>.*<tt:Protocol>RTSP<\/tt:Protocol>.*<trt:ProfileToken>Profile_1</);
});

test('GetCapabilities XAddrs and path rewriting', () => {
  const xml = wrap(`<tds:GetCapabilitiesResponse><tds:Capabilities>
    <tt:Analytics><tt:XAddr>http://192.168.1.70/onvif/analytics_service</tt:XAddr><tt:RuleSupport>true</tt:RuleSupport></tt:Analytics>
    <tt:Device><tt:XAddr>http://192.168.1.70/onvif/device_service</tt:XAddr><tt:Network><tt:IPFilter>false</tt:IPFilter></tt:Network></tt:Device>
    <tt:Events><tt:XAddr>http://192.168.1.70/onvif/event_service</tt:XAddr><tt:WSSubscriptionPolicySupport>true</tt:WSSubscriptionPolicySupport></tt:Events>
    <tt:Imaging><tt:XAddr>http://192.168.1.70/onvif/imaging_service</tt:XAddr></tt:Imaging>
    <tt:Media><tt:XAddr>http://192.168.1.70/onvif/media_service</tt:XAddr><tt:StreamingCapabilities><tt:RTPMulticast>true</tt:RTPMulticast></tt:StreamingCapabilities></tt:Media>
    <tt:PTZ><tt:XAddr>http://10.1.1.1:8080/onvif/ptz_service</tt:XAddr></tt:PTZ>
    <tt:Extension><tt:DeviceIO><tt:XAddr>http://192.168.1.70/onvif/deviceIO_service</tt:XAddr></tt:DeviceIO></tt:Extension>
  </tds:Capabilities></tds:GetCapabilitiesResponse>`);
  const caps = parseCapabilities(xml);
  assert.deepEqual(caps, {
    device: 'http://192.168.1.70/onvif/device_service',
    media: 'http://192.168.1.70/onvif/media_service',
    ptz: 'http://10.1.1.1:8080/onvif/ptz_service',
    events: 'http://192.168.1.70/onvif/event_service',
  });
  assert.equal(xaddrPath(caps.ptz, '/x'), '/onvif/ptz_service');
  assert.equal(xaddrPath('http://[fe80::1]:80/onvif/Media?x=1', '/x'), '/onvif/Media?x=1');
  assert.equal(xaddrPath('http://192.168.1.70', '/onvif/device_service'), '/onvif/device_service');
  assert.equal(xaddrPath(undefined, '/d'), '/d');
});

test('GetServices namespaces, including Media2 and multiple addresses', () => {
  const xml = wrap(`<tds:GetServicesResponse>
    <tds:Service><tds:Namespace>http://www.onvif.org/ver10/device/wsdl</tds:Namespace><tds:XAddr>http://192.168.1.9:2020/onvif/device_service</tds:XAddr><tds:Version><tt:Major>2</tt:Major></tds:Version></tds:Service>
    <tds:Service><tds:Namespace>http://www.onvif.org/ver10/media/wsdl</tds:Namespace><tds:XAddr>http://192.168.1.9:2020/onvif/service http://[fe80::1]:2020/onvif/service</tds:XAddr></tds:Service>
    <tds:Service><tds:Namespace>http://www.onvif.org/ver20/media/wsdl</tds:Namespace><tds:XAddr>http://192.168.1.9:2020/onvif/media2</tds:XAddr></tds:Service>
    <tds:Service><tds:Namespace>http://www.onvif.org/ver20/ptz/wsdl</tds:Namespace><tds:XAddr>http://192.168.1.9:2020/onvif/service</tds:XAddr></tds:Service>
    <tds:Service><tds:Namespace>http://www.onvif.org/ver10/events/wsdl</tds:Namespace><tds:XAddr>http://192.168.1.9:2020/event-1</tds:XAddr></tds:Service>
  </tds:GetServicesResponse>`);
  assert.deepEqual(parseServices(xml), {
    device: 'http://192.168.1.9:2020/onvif/device_service',
    media: 'http://192.168.1.9:2020/onvif/service',
    media2: 'http://192.168.1.9:2020/onvif/media2',
    ptz: 'http://192.168.1.9:2020/onvif/service',
    events: 'http://192.168.1.9:2020/event-1',
  });
});

test('GetPresets and GetNodes', () => {
  const presets = wrap(`<tptz:GetPresetsResponse>
    <tptz:Preset token="1"><tt:Name>Driveway</tt:Name><tt:PTZPosition><tt:PanTilt x="0.1" y="0.2" space="http://www.onvif.org/ver10/tptz/PanTiltSpaces/PositionGenericSpace"/></tt:PTZPosition></tptz:Preset>
    <tptz:Preset token="2"><tt:Name>Front &amp; Gate</tt:Name></tptz:Preset>
    <tptz:Preset token="3"/>
  </tptz:GetPresetsResponse>`);
  assert.deepEqual(parsePresets(presets), [
    { token: '1', name: 'Driveway' },
    { token: '2', name: 'Front & Gate' },
    { token: '3', name: '3' },
  ]);
  const nodes = wrap(`<tptz:GetNodesResponse><tptz:PTZNode token="PTZNODETOKEN" FixedHomePosition="false">
    <tt:Name>PTZNODE</tt:Name>
    <tt:SupportedPTZSpaces>
      <tt:AbsolutePanTiltPositionSpace><tt:URI>http://www.onvif.org/ver10/tptz/PanTiltSpaces/PositionGenericSpace</tt:URI></tt:AbsolutePanTiltPositionSpace>
      <tt:ContinuousPanTiltVelocitySpace><tt:URI>http://www.onvif.org/ver10/tptz/PanTiltSpaces/VelocityGenericSpace</tt:URI></tt:ContinuousPanTiltVelocitySpace>
    </tt:SupportedPTZSpaces>
    <tt:MaximumNumberOfPresets>255</tt:MaximumNumberOfPresets>
  </tptz:PTZNode></tptz:GetNodesResponse>`);
  assert.deepEqual(parsePtzNodes(nodes), [{ token: 'PTZNODETOKEN', canMove: true, canZoom: false }]);
  assert.match(body.continuousMove('P', { x: -0.5, y: 0 }), /<tt:PanTilt x="-0.5" y="0"\/>/);
  assert.match(body.continuousMove('P', { zoom: 0.5 }), /<tt:Zoom x="0.5"\/>/);
  assert.match(body.gotoPreset('P', '2'), /<tptz:PresetToken>2<\/tptz:PresetToken>/);
});

test('SOAP fault ter:NotAuthorized means wrong username or password', () => {
  const xml = wrap(`<SOAP-ENV:Fault><SOAP-ENV:Code><SOAP-ENV:Value>SOAP-ENV:Sender</SOAP-ENV:Value>
    <SOAP-ENV:Subcode><SOAP-ENV:Value>ter:NotAuthorized</SOAP-ENV:Value></SOAP-ENV:Subcode></SOAP-ENV:Code>
    <SOAP-ENV:Reason><SOAP-ENV:Text xml:lang="en">Sender not Authorized</SOAP-ENV:Text></SOAP-ENV:Reason></SOAP-ENV:Fault>`);
  const f = parseFault(xml)!;
  assert.deepEqual(f.codes, ['Sender', 'NotAuthorized']);
  assert.equal(f.reason, 'Sender not Authorized');
  assert.ok(isAuthFault(f));
  assert.equal(faultMessage(f), 'Wrong username or password.');
  assert.equal(parseFault(PROFILES), null);
});

test('other faults are plain language', () => {
  const f = parseFault(wrap(`<s:Fault xmlns:s="x"><s:Code><s:Value>s:Receiver</s:Value><s:Subcode><s:Value>ter:ActionNotSupported</s:Value><s:Subcode><s:Value>ter:NoSuchService</s:Value></s:Subcode></s:Subcode></s:Code><s:Reason><s:Text xml:lang="en">Optional Action Not Implemented</s:Text></s:Reason></s:Fault>`))!;
  assert.deepEqual(f.codes, ['Receiver', 'ActionNotSupported', 'NoSuchService']);
  assert.ok(!isAuthFault(f));
  assert.equal(faultMessage(f), 'The camera doesn’t support this feature.');
  const legacy = parseFault('<Envelope><Body><Fault><faultcode>SOAP-ENV:Client</faultcode><faultstring>Bad profile</faultstring></Fault></Body></Envelope>')!;
  assert.equal(faultMessage(legacy), 'The camera refused the request: Bad profile');
});

test('device information and clock', () => {
  const info = parseDeviceInfo(wrap(`<tds:GetDeviceInformationResponse><tds:Manufacturer>Amcrest</tds:Manufacturer><tds:Model>IP4M-1041B</tds:Model><tds:FirmwareVersion>2.800</tds:FirmwareVersion><tds:SerialNumber>AMC0</tds:SerialNumber><tds:HardwareId>1.00</tds:HardwareId></tds:GetDeviceInformationResponse>`));
  assert.equal(deviceName(info), 'Amcrest IP4M-1041B');
  assert.equal(deviceName({ ...info, manufacturer: 'HIKVISION', model: 'Hikvision DS-2CD2143' }), 'Hikvision DS-2CD2143');
  assert.equal(deviceName({ ...info, model: '' }), 'Amcrest');

  const time = wrap(`<tds:GetSystemDateAndTimeResponse><tds:SystemDateAndTime>
    <tt:DateTimeType>NTP</tt:DateTimeType><tt:DaylightSavings>false</tt:DaylightSavings><tt:TimeZone><tt:TZ>CST6CDT</tt:TZ></tt:TimeZone>
    <tt:UTCDateTime><tt:Time><tt:Hour>14</tt:Hour><tt:Minute>5</tt:Minute><tt:Second>9</tt:Second></tt:Time><tt:Date><tt:Year>2026</tt:Year><tt:Month>10</tt:Month><tt:Day>10</tt:Day></tt:Date></tt:UTCDateTime>
    <tt:LocalDateTime><tt:Time><tt:Hour>9</tt:Hour><tt:Minute>5</tt:Minute><tt:Second>9</tt:Second></tt:Time><tt:Date><tt:Year>2026</tt:Year><tt:Month>10</tt:Month><tt:Day>10</tt:Day></tt:Date></tt:LocalDateTime>
  </tds:SystemDateAndTime></tds:GetSystemDateAndTimeResponse>`);
  assert.equal(parseSystemTime(time), Date.UTC(2026, 9, 10, 14, 5, 9));
  assert.equal(parseSystemTime(wrap('<x/>')), null);
});

test('stream URLs: credentials encoded, unreachable hosts rewritten', () => {
  assert.equal(
    streamUrl('rtsp://192.168.1.70:554/Streaming/Channels/101?transportmode=unicast', '192.168.1.70', 'admin', 'p@ss:w/rd#1'),
    'rtsp://admin:p%40ss%3Aw%2Frd%231@192.168.1.70:554/Streaming/Channels/101?transportmode=unicast',
  );
  // Camera behind Docker/NAT or reporting a default IP on another subnet.
  assert.equal(streamUrl('rtsp://192.168.0.100/live', '10.0.0.20', 'u', 'p'), 'rtsp://u:p@10.0.0.20/live');
  assert.equal(streamUrl('rtsp://0.0.0.0:8554/ch0', '192.168.1.5', 'u', ''), 'rtsp://u@192.168.1.5:8554/ch0');
  assert.equal(streamUrl('rtsp://olduser:old@127.0.0.1/a', 'cam.local', 'new', 'pw'), 'rtsp://new:pw@cam.local/a');
  // A recorder pointing at one of its cameras on the same subnet is left alone.
  assert.equal(streamUrl('rtsp://192.168.1.71/ch1', '192.168.1.70', 'u', 'p'), 'rtsp://u:p@192.168.1.71/ch1');

  assert.equal(shouldRewriteHost('192.168.1.70', '192.168.1.70'), false);
  assert.equal(shouldRewriteHost('169.254.1.2', '192.168.1.70'), true);
  assert.equal(shouldRewriteHost('192.168.1.70', 'home.example.com'), true);
  assert.equal(shouldRewriteHost('ipcam', '192.168.1.70'), true);
});

test('snapshot URLs go through the gateway when they point at the camera', () => {
  const gw = 'http://127.0.0.1:50123';
  assert.equal(snapshotUrl('http://192.168.1.70/onvif-http/snapshot?Profile_1', gw, '192.168.1.70', '80'), `${gw}/onvif-http/snapshot?Profile_1`);
  assert.equal(snapshotUrl('http://192.168.1.70:80/cgi-bin/snapshot.cgi?channel=1', gw, '192.168.1.70', '80'), `${gw}/cgi-bin/snapshot.cgi?channel=1`);
  assert.equal(snapshotUrl('http://172.17.0.2/snap.jpg', gw, '192.168.1.70', '80'), `${gw}/snap.jpg`);
  assert.equal(snapshotUrl('/snap.jpg', gw, '192.168.1.70', '80'), `${gw}/snap.jpg`);
  // Different port on the same camera can't be proxied; fetched directly.
  assert.equal(snapshotUrl('http://192.168.1.70:8080/snap.jpg', gw, '192.168.1.70', '80'), 'http://192.168.1.70:8080/snap.jpg');
  assert.equal(snapshotUrl('', gw, '192.168.1.70', '80'), '');
});
