package backend

// Planned backends (docs/PLATFORM.md §4). Each goes in its own package next to frigate/ and is
// registered in the Hub's newBackend() switch (bridge/systems.go). None are implemented yet;
// the setup page only offers Frigate.
//
// TODO(hikvision): ISAPI. Cameras from /ISAPI/ContentMgmt/InputProxy/channels, snapshots from
//   /ISAPI/Streaming/channels/<n>01/picture, live = LiveRTSP rtsp://…/Streaming/Channels/<n>01,
//   events from the /ISAPI/Event/notification/alertStream multipart stream, recordings via
//   /ISAPI/ContentMgmt/search + RTSP playback (?starttime=) remuxed to fMP4 HLS by the Hub.
//   Digest auth (see tunnel/wgtunnel/digest.go for a working implementation).
//
// TODO(dahua): CGI API. /cgi-bin/configManager.cgi?action=getConfig&name=ChannelTitle,
//   /cgi-bin/snapshot.cgi, RTSP /cam/realmonitor, events from /cgi-bin/eventManager.cgi
//   ?action=attach, playback /cam/playback?starttime=. Digest auth.
//
// TODO(reolink): HTTP JSON API (/cgi-bin/api.cgi?cmd=…, token login), RTSP/RTMP live,
//   Search + Playback commands for recordings, AI state polling or Baichuan push for events.
//
// TODO(unifi-protect): UniFi OS login (/api/auth/login), bootstrap (/proxy/protect/api/
//   bootstrap), RTSPS live from the per-channel rtspAlias, events from the updates websocket,
//   recordings via /proxy/protect/api/video/export (Clip) since there is no HLS VOD.
//
// TODO(onvif): ONVIF Profile S/T: GetProfiles + GetStreamUri (LiveRTSP), GetSnapshotUri,
//   PullPoint subscription for motion/analytics events, PTZ ContinuousMove/Stop/GotoPreset.
//   Profile G (recording search/replay) where the camera supports it.
//
// TODO(rtsp): plain RTSP cameras with no API: Cameras from config, Live = LiveRTSP, everything
//   else ErrUnsupported (or the Hub records them itself in a later version).
