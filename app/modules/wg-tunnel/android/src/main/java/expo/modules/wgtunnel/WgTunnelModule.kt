package expo.modules.wgtunnel

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.system.Os
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.net.Inet4Address
import wgtunnel.Wgtunnel

// Thin bridge over the gomobile-generated wgtunnel library (see /tunnel), the Android twin
// of ios/WgTunnelModule.swift: same function names, arguments, results and error names.
// AsyncFunctions run off the main thread, so blocking Go calls are fine here.
// Go `int` is a Java `long`; JS numbers arrive as Int.
class WgTunnelModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("WgTunnel")

    OnCreate {
      appContext.reactContext?.let { ctx ->
        // Go's os.TempDir() is /data/local/tmp on Android, which apps can't write.
        // Set before the Go library loads (Go copies the environment at start-up).
        runCatching { Os.setenv("TMPDIR", ctx.cacheDir.absolutePath, true) }
        runCatching { go.Seq.setContext(ctx.applicationContext) }
      }
    }

    AsyncFunction("startTunnel") { conf: String ->
      goCall("TunnelError") { Wgtunnel.startTunnel(conf) }
    }

    AsyncFunction<Unit>("stopTunnel") {
      Wgtunnel.stopTunnel()
    }

    Function<String>("tunnelStatus") {
      Wgtunnel.tunnelStatus()
    }

    Function("validateConfig") { conf: String ->
      Wgtunnel.validateConfig(conf)
    }

    AsyncFunction("probe") { hostport: String, viaTunnel: Boolean, timeoutMs: Int ->
      Wgtunnel.probe(hostport, viaTunnel, timeoutMs.toLong())
    }

    // Diagnostics: the real error text instead of a yes/no.
    AsyncFunction("probeError") { hostport: String, viaTunnel: Boolean, timeoutMs: Int ->
      Wgtunnel.probeError(hostport, viaTunnel, timeoutMs.toLong())
    }

    AsyncFunction("httpCheck") { url: String, viaTunnel: Boolean, timeoutMs: Int ->
      Wgtunnel.httpCheck(url, viaTunnel, timeoutMs.toLong())
    }

    // Local-network discovery for setup. Android 11+ hides the network interfaces from
    // Go, so pass the addresses Android reports first.
    Function<String>("localSubnets") {
      shareLocalAddresses()
      Wgtunnel.localSubnets()
    }

    AsyncFunction("scanSubnet") { cidr: String, ports: String, timeoutMs: Int ->
      Wgtunnel.scanSubnet(cidr, ports, timeoutMs.toLong())
    }

    AsyncFunction("httpProbe") { url: String, timeoutMs: Int ->
      Wgtunnel.httpProbe(url, timeoutMs.toLong())
    }

    AsyncFunction("addRoute") {
      target: String, viaTunnel: Boolean, insecureTLS: Boolean, authKind: String, user: String, pass: String ->
      goCall("RouteError") {
        Wgtunnel.addRoute(target, viaTunnel, insecureTLS, authKind, user, pass).toInt()
      }
    }

    Function("setRouteViaTunnel") { port: Int, viaTunnel: Boolean ->
      Wgtunnel.setRouteViaTunnel(port.toLong(), viaTunnel)
    }

    Function("removeRoute") { port: Int ->
      Wgtunnel.removeRoute(port.toLong())
    }

    AsyncFunction("addRTSPSource") { url: String, viaTunnel: Boolean ->
      goCall("RTSPError") { Wgtunnel.addRTSPSource(url, viaTunnel).toInt() }
    }

    Function("setRTSPViaTunnel") { port: Int, viaTunnel: Boolean ->
      Wgtunnel.setRTSPViaTunnel(port.toLong(), viaTunnel)
    }

    Function("removeRTSPSource") { port: Int ->
      Wgtunnel.removeRTSPSource(port.toLong())
    }

    // Two-way audio: a loopback WebSocket the microphone page feeds (see tunnel/wgtunnel/talk.go).
    AsyncFunction("addTalk") { kind: String, url: String, viaTunnel: Boolean ->
      goCall("TalkError") { Wgtunnel.addTalk(kind, url, viaTunnel).toInt() }
    }

    Function("removeTalk") { port: Int ->
      Wgtunnel.removeTalk(port.toLong())
    }

    AsyncFunction("probeTalk") { kind: String, url: String, viaTunnel: Boolean, timeoutMs: Int ->
      Wgtunnel.probeTalk(kind, url, viaTunnel, timeoutMs.toLong())
    }

    // Values notification handling needs (bridge secret / URL). iOS keeps them in the App
    // Group keychain; here an app-private store encrypted with an Android Keystore key.
    Function("setShared") { name: String, value: String ->
      runCatching { SharedStore.set(context, name, value) } // best effort, like SecItemAdd
      Unit
    }

    Function("removeShared") { name: String ->
      runCatching { SharedStore.remove(context, name) }
      Unit
    }

    AsyncFunction("login") { port: Int ->
      Wgtunnel.login(port.toLong())
    }

    // Phone-to-phone transfer: serve one encrypted bundle on the home Wi-Fi (see tunnel/wgtunnel/transfer.go).
    AsyncFunction("transferServe") { token: String, payload: String, ttlSec: Int ->
      shareLocalAddresses()
      Wgtunnel.transferServe(token, payload, ttlSec.toLong())
    }

    Function<String>("transferStatus") {
      Wgtunnel.transferStatus()
    }

    Function<Unit>("transferStop") {
      Wgtunnel.transferStop()
    }

    AsyncFunction("transferFetch") { url: String, timeoutMs: Int ->
      Wgtunnel.transferFetch(url, timeoutMs.toLong())
    }

    // PBKDF2-SHA256 for passcode-protected backup files.
    AsyncFunction("deriveKey") { passcode: String, saltB64: String, iterations: Int ->
      Wgtunnel.deriveKey(passcode, saltB64, iterations.toLong())
    }

    // Evidence export (tunnel/wgtunnel/record.go, sign.go, zipdir.go).
    AsyncFunction("startRecording") { url: String, viaTunnel: Boolean, outPath: String, maxSeconds: Int ->
      goCall("RecordError") {
        Wgtunnel.startRecording(url, viaTunnel, outPath, maxSeconds.toLong()).toInt()
      }
    }

    Function("recordingStatus") { id: Int ->
      Wgtunnel.recordingStatus(id.toLong())
    }

    AsyncFunction("stopRecording") { id: Int ->
      Wgtunnel.stopRecording(id.toLong())
    }

    AsyncFunction<String>("newSigningKey") {
      goCall("SignError") { Wgtunnel.newSigningKey() }
    }

    AsyncFunction("signingPublicKey") { privateKey: String ->
      goCall("SignError") { Wgtunnel.signingPublicKeyPEM(privateKey) }
    }

    AsyncFunction("signFile") { privateKey: String, path: String, sigPath: String ->
      goCall("SignError") { Wgtunnel.signFile(privateKey, path, sigPath) }
    }

    AsyncFunction("sha256File") { path: String ->
      // gomobile spells Go's SHA256File as shA256File.
      goCall("HashError") { Wgtunnel.shA256File(path) }
    }

    AsyncFunction("zipFolder") { dir: String, outPath: String, rootName: String ->
      goCall("ZipError") { Wgtunnel.zipFolder(dir, outPath, rootName) }
    }
  }

  /**
   * Hands Go the phone's private Wi-Fi/Ethernet IPv4 addresses from
   * ConnectivityManager, since net.Interfaces is blocked for apps on Android 11+.
   */
  @Suppress("DEPRECATION") // allNetworks: still the simplest way to list every network
  private fun shareLocalAddresses() {
    val list = runCatching {
      val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
      val lan = mutableListOf<String>()
      for (network in cm.allNetworks) {
        val caps = cm.getNetworkCapabilities(network) ?: continue
        val props = cm.getLinkProperties(network) ?: continue
        val isLan = caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) ||
          caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)
        if (!isLan) continue // cellular addresses are no use for finding cameras
        for (la in props.linkAddresses) {
          val addr = la.address
          if (addr is Inet4Address && addr.isSiteLocalAddress) {
            val entry = "${addr.hostAddress}/${la.prefixLength}"
            lan += entry
          }
        }
      }
      lan.joinToString(",")
    }.getOrDefault("")
    Wgtunnel.setLocalAddresses(list)
  }
}

/** Runs a Go call that can fail, rethrowing its error under the same name iOS uses. */
private inline fun <T> goCall(name: String, block: () -> T): T {
  try {
    return block()
  } catch (e: CodedException) {
    throw e
  } catch (e: Exception) {
    throw GoException(name, e)
  }
}

/** Same `code` as the Swift `Exception(name:description:)`, e.g. TunnelError → ERR_TUNNEL. */
internal class GoException(name: String, cause: Exception) :
  CodedException(codeFor(name), cause.message ?: name, cause) {
  companion object {
    fun codeFor(name: String): String =
      "ERR_" + name
        .replace(Regex("(Error|Exception)?$"), "")
        .replace(Regex("(.)([A-Z])"), "$1_$2")
        .uppercase()
  }
}
