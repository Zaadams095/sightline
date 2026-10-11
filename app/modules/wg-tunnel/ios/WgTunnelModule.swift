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
