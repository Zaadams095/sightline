import CoreImage
import CoreImage.CIFilterBuiltins
import ExpoModulesCore
import Foundation
import Network
import Security
import UIKit

/// Signing in on the TV without typing and without any cloud:
///
/// 1. The TV listens on a random port on the home network and shows a QR code with
///    `sightline://tv?h=<ip:port>&k=<one-time key>`.
/// 2. The iPhone app scans it, creates a Hub invite for the TV and POSTs it to
///    `http://<ip:port>/pair` with the key.
/// 3. JS (onPairRequest) redeems the invite at the Hub, keeps the TV's own token in the
///    keychain, and answers the phone through `respond`.
public class TvPairingModule: Module {
  public func definition() -> ModuleDefinition {
    Name("TvPairing")

    Events("onPairRequest")

    OnCreate {
      PairServer.shared.onRequest = { [weak self] id, body in
        self?.sendEvent("onPairRequest", ["id": id, "body": body])
      }
    }

    OnDestroy {
      PairServer.shared.onRequest = nil
      PairServer.shared.stop()
    }

    /// Starts listening; resolves {host, port, key}. host is "" without a network.
    AsyncFunction("start") { (promise: Promise) in
      PairServer.shared.start { result in
        switch result {
        case .success(let info):
          promise.resolve(info)
        case .failure(let error):
          promise.reject("ERR_PAIR_LISTEN", error.localizedDescription)
        }
      }
    }

    Function("stop") {
      PairServer.shared.stop()
    }

    /// Answers a pairing request: HTTP status and a JSON body for the phone.
    Function("respond") { (id: String, status: Int, json: String) in
      PairServer.shared.respond(id: id, status: status, json: json)
    }

    /// PNG (base64) of a QR code for `text`.
    Function("qrPng") { (text: String) -> String in
      QR.png(text)?.base64EncodedString() ?? ""
    }

    Function("getSecret") { (name: String) -> String? in
      TVKeychain.get(name)
    }

    Function("setSecret") { (name: String, value: String) in
      TVKeychain.set(name, value)
    }

    Function("removeSecret") { (name: String) in
      TVKeychain.remove(name)
    }
  }
}

final class PairServer {
  static let shared = PairServer()

  var onRequest: ((String, String) -> Void)?

  private let queue = DispatchQueue(label: "sightline.tv.pair")
  private var listener: NWListener?
  private var key = ""
  private var pending: [String: NWConnection] = [:]

  func start(_ done: @escaping (Result<[String: Any], Error>) -> Void) {
    queue.async {
      self.stopLocked()
      self.key = Self.randomKey()
      do {
        let params = NWParameters.tcp
        params.allowLocalEndpointReuse = true
        let listener = try NWListener(using: params, on: .any)
        self.listener = listener
        // Report the first ready/failed state only (a class, so the handler can update it).
        let reported = Flag()
        let key = self.key
        listener.stateUpdateHandler = { [weak listener] state in
          guard !reported.value else { return }
          switch state {
          case .ready:
            reported.value = true
            let port = Int(listener?.port?.rawValue ?? 0)
            done(.success(["host": PairServer.localIPv4() ?? "", "port": port, "key": key]))
          case .failed(let error):
            reported.value = true
            done(.failure(error))
          default:
            break
          }
        }
        listener.newConnectionHandler = { [weak self] conn in
          self?.accept(conn)
        }
        listener.start(queue: self.queue)
      } catch {
        done(.failure(error))
      }
    }
  }

  func stop() {
    queue.async { self.stopLocked() }
  }

  private func stopLocked() {
    listener?.cancel()
    listener = nil
    for (_, conn) in pending { conn.cancel() }
    pending.removeAll()
  }

  func respond(id: String, status: Int, json: String) {
    queue.async {
      guard let conn = self.pending.removeValue(forKey: id) else { return }
      Self.send(conn, status: status, body: json)
    }
  }

  private func accept(_ conn: NWConnection) {
    conn.start(queue: queue)
    receive(conn, buffer: Data())
    // Nobody keeps a half-open connection to the TV for long.
    queue.asyncAfter(deadline: .now() + 30) {
      if let id = self.pending.first(where: { $0.value === conn })?.key {
        self.pending.removeValue(forKey: id)
        Self.send(conn, status: 504, body: #"{"error":"The TV didn't answer in time."}"#)
      } else {
        conn.cancel()
      }
    }
  }

  private func receive(_ conn: NWConnection, buffer: Data) {
    conn.receive(minimumIncompleteLength: 1, maximumLength: 16 * 1024) { [weak self] data, _, isComplete, error in
      guard let self else { return }
      var buf = buffer
      if let data { buf.append(data) }
      if buf.count > 64 * 1024 {
        Self.send(conn, status: 413, body: #"{"error":"Too large"}"#)
        return
      }
      if let request = HTTPRequest.parse(buf) {
        self.handle(conn, request)
      } else if isComplete || error != nil {
        conn.cancel()
      } else {
        self.receive(conn, buffer: buf)
      }
    }
  }

  private func handle(_ conn: NWConnection, _ req: HTTPRequest) {
    guard req.method == "POST", req.path == "/pair" else {
      Self.send(conn, status: 404, body: #"{"error":"Not found"}"#)
      return
    }
    guard let obj = try? JSONSerialization.jsonObject(with: req.body) as? [String: Any],
          let given = obj["key"] as? String, Self.equal(given, key), !key.isEmpty else {
      Self.send(conn, status: 403, body: #"{"error":"That code is out of date. Scan the code on the TV again."}"#)
      return
    }
    guard let onRequest else {
      Self.send(conn, status: 503, body: #"{"error":"The TV app isn't ready yet."}"#)
      return
    }
    let id = UUID().uuidString
    pending[id] = conn
    onRequest(id, String(data: req.body, encoding: .utf8) ?? "{}")
  }

  private static func send(_ conn: NWConnection, status: Int, body: String) {
    let text = status == 200 ? "OK" : "Error"
    let payload = Data(body.utf8)
    let head = "HTTP/1.1 \(status) \(text)\r\nContent-Type: application/json\r\nContent-Length: \(payload.count)\r\nConnection: close\r\n\r\n"
    var data = Data(head.utf8)
    data.append(payload)
    conn.send(content: data, completion: .contentProcessed { _ in conn.cancel() })
  }

  private static func equal(_ a: String, _ b: String) -> Bool {
    let x = Array(a.utf8), y = Array(b.utf8)
    guard x.count == y.count else { return false }
    var diff: UInt8 = 0
    for i in 0..<x.count { diff |= x[i] ^ y[i] }
    return diff == 0
  }

  private static func randomKey() -> String {
    var bytes = [UInt8](repeating: 0, count: 16)
    _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
    return bytes.map { String(format: "%02x", $0) }.joined()
  }

  /// The TV's IPv4 address on the home network (Ethernet or Wi-Fi).
  static func localIPv4() -> String? {
    var ifaddr: UnsafeMutablePointer<ifaddrs>?
    guard getifaddrs(&ifaddr) == 0, let first = ifaddr else { return nil }
    defer { freeifaddrs(ifaddr) }
    var best: String?
    for ptr in sequence(first: first, next: { $0.pointee.ifa_next }) {
      let iface = ptr.pointee
      guard let addr = iface.ifa_addr, addr.pointee.sa_family == UInt8(AF_INET) else { continue }
      let flags = Int32(iface.ifa_flags)
      guard flags & IFF_UP != 0, flags & IFF_LOOPBACK == 0 else { continue }
      let name = String(cString: iface.ifa_name)
      guard name.hasPrefix("en") else { continue }
      var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
      if getnameinfo(addr, socklen_t(addr.pointee.sa_len), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0 {
        let ip = String(cString: host)
        // Prefer en0 (Ethernet on Apple TV), else the first other interface (Wi-Fi).
        if name == "en0" { return ip }
        if best == nil { best = ip }
      }
    }
    return best
  }
}

final class Flag {
  var value = false
}

struct HTTPRequest {
  let method: String
  let path: String
  let body: Data

  /// A complete request (headers and Content-Length body), or nil if more bytes are needed.
  static func parse(_ data: Data) -> HTTPRequest? {
    let sep = Data("\r\n\r\n".utf8)
    guard let range = data.range(of: sep), let head = String(data: data[..<range.lowerBound], encoding: .utf8) else { return nil }
    let lines = head.components(separatedBy: "\r\n")
    let parts = lines.first?.split(separator: " ") ?? []
    guard parts.count >= 2 else { return nil }
    var length = 0
    for line in lines.dropFirst() {
      let kv = line.split(separator: ":", maxSplits: 1)
      if kv.count == 2, kv[0].trimmingCharacters(in: .whitespaces).lowercased() == "content-length" {
        length = Int(kv[1].trimmingCharacters(in: .whitespaces)) ?? 0
      }
    }
    let bodyStart = range.upperBound
    guard data.count - bodyStart >= length else { return nil }
    let body = data.subdata(in: bodyStart..<(bodyStart + length))
    let path = String(parts[1]).components(separatedBy: "?").first ?? ""
    return HTTPRequest(method: String(parts[0]), path: path, body: body)
  }
}

enum QR {
  static func png(_ text: String) -> Data? {
    let filter = CIFilter.qrCodeGenerator()
    filter.message = Data(text.utf8)
    filter.correctionLevel = "M"
    guard let output = filter.outputImage else { return nil }
    let scaled = output.transformed(by: CGAffineTransform(scaleX: 12, y: 12))
    guard let cg = CIContext().createCGImage(scaled, from: scaled.extent) else { return nil }
    return UIImage(cgImage: cg).pngData()
  }
}

enum TVKeychain {
  private static let service = "sightline.tv"

  private static func query(_ name: String) -> [String: Any] {
    [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: name]
  }

  static func get(_ name: String) -> String? {
    var q = query(name)
    q[kSecReturnData as String] = true
    q[kSecMatchLimit as String] = kSecMatchLimitOne
    var out: CFTypeRef?
    guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
    return String(data: data, encoding: .utf8)
  }

  static func set(_ name: String, _ value: String) {
    remove(name)
    var q = query(name)
    q[kSecValueData as String] = Data(value.utf8)
    q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    SecItemAdd(q as CFDictionary, nil)
  }

  static func remove(_ name: String) {
    SecItemDelete(query(name) as CFDictionary)
  }
}
