import ExpoModulesCore
import Wgtunnel

// Thin bridge over the gomobile-generated Wgtunnel framework (see /tunnel).
// AsyncFunctions run off the main thread, so blocking Go calls are fine here.
public class WgTunnelModule: Module {
  public func definition() -> ModuleDefinition {
    Name("WgTunnel")

    AsyncFunction("startTunnel") { (conf: String) in
      var error: NSError?
      WgtunnelStartTunnel(conf, &error)
      if let error { throw Exception(name: "TunnelError", description: error.localizedDescription) }
    }

    AsyncFunction("stopTunnel") {
      WgtunnelStopTunnel()
    }

    Function("tunnelStatus") { () -> String in
      WgtunnelTunnelStatus()
    }

    Function("validateConfig") { (conf: String) -> String in
      WgtunnelValidateConfig(conf)
    }

    AsyncFunction("probe") { (hostport: String, viaTunnel: Bool, timeoutMs: Int) -> Bool in
      WgtunnelProbe(hostport, viaTunnel, timeoutMs)
    }

    // Diagnostics: the real error text instead of a yes/no.
    AsyncFunction("probeError") { (hostport: String, viaTunnel: Bool, timeoutMs: Int) -> String in
      WgtunnelProbeError(hostport, viaTunnel, timeoutMs)
    }

    AsyncFunction("httpCheck") { (url: String, viaTunnel: Bool, timeoutMs: Int) -> String in
      WgtunnelHTTPCheck(url, viaTunnel, timeoutMs)
    }

    // Local-network discovery for setup.
    Function("localSubnets") { () -> String in
      WgtunnelLocalSubnets()
    }

    AsyncFunction("scanSubnet") { (cidr: String, ports: String, timeoutMs: Int) -> String in
      WgtunnelScanSubnet(cidr, ports, timeoutMs)
    }

    AsyncFunction("httpProbe") { (url: String, timeoutMs: Int) -> String in
      WgtunnelHTTPProbe(url, timeoutMs)
    }

    AsyncFunction("addRoute") {
      (target: String, viaTunnel: Bool, insecureTLS: Bool, authKind: String, user: String, pass: String) -> Int in
      var port: Int = 0
      var error: NSError?
      WgtunnelAddRoute(target, viaTunnel, insecureTLS, authKind, user, pass, &port, &error)
      if let error { throw Exception(name: "RouteError", description: error.localizedDescription) }
      return port
    }

    Function("setRouteViaTunnel") { (port: Int, viaTunnel: Bool) in
      WgtunnelSetRouteViaTunnel(port, viaTunnel)
    }

    Function("removeRoute") { (port: Int) in
      WgtunnelRemoveRoute(port)
    }

    AsyncFunction("addRTSPSource") { (url: String, viaTunnel: Bool) -> Int in
      var port: Int = 0
      var error: NSError?
      WgtunnelAddRTSPSource(url, viaTunnel, &port, &error)
      if let error { throw Exception(name: "RTSPError", description: error.localizedDescription) }
      return port
    }

    Function("setRTSPViaTunnel") { (port: Int, viaTunnel: Bool) in
      WgtunnelSetRTSPViaTunnel(port, viaTunnel)
    }

    Function("removeRTSPSource") { (port: Int) in
      WgtunnelRemoveRTSPSource(port)
    }

    // Two-way audio: a loopback WebSocket the microphone page feeds (see tunnel/wgtunnel/talk.go).
    AsyncFunction("addTalk") { (kind: String, url: String, viaTunnel: Bool) -> Int in
      var port: Int = 0
      var error: NSError?
      WgtunnelAddTalk(kind, url, viaTunnel, &port, &error)
      if let error { throw Exception(name: "TalkError", description: error.localizedDescription) }
      return port
    }

    Function("removeTalk") { (port: Int) in
      WgtunnelRemoveTalk(port)
    }

    AsyncFunction("probeTalk") { (kind: String, url: String, viaTunnel: Bool, timeoutMs: Int) -> String in
      WgtunnelProbeTalk(kind, url, viaTunnel, timeoutMs)
    }

    // Values the notification extension needs (bridge secret / URL), via the App Group keychain.
    Function("setShared") { (name: String, value: String) in
      SharedKeychain.set(name, value)
    }

    Function("removeShared") { (name: String) in
      SharedKeychain.remove(name)
    }

    AsyncFunction("login") { (port: Int) -> String in
      WgtunnelLogin(port)
    }
  }
}
