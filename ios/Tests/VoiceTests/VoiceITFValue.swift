import Foundation

/// Test-only ITF boundary. Numeric values are never coerced from JSON doubles.
indirect enum ITFValue: Equatable, Decodable {
  case integer(Int)
  case boolean(Bool)
  case string(String)
  case list([ITFValue])
  case set([ITFValue])
  case record([String: ITFValue])
  case variant(String, ITFValue)
  case unit

  static func == (lhs: ITFValue, rhs: ITFValue) -> Bool {
    switch (lhs, rhs) {
    case (.integer(let a), .integer(let b)): return a == b
    case (.boolean(let a), .boolean(let b)): return a == b
    case (.string(let a), .string(let b)): return a == b
    case (.list(let a), .list(let b)): return a == b
    case (.set(let a), .set(let b)): return a.count == b.count && a.allSatisfy(b.contains)
    case (.record(let a), .record(let b)): return a == b
    case (.variant(let at, let av), .variant(let bt, let bv)): return at == bt && av == bv
    case (.unit, .unit): return true
    default: return false
    }
  }

  init(from decoder: any Decoder) throws {
    let value = try decoder.singleValueContainer()
    if let flag = try? value.decode(Bool.self) {
      self = .boolean(flag)
      return
    }
    if let text = try? value.decode(String.self) {
      self = .string(text)
      return
    }
    if let list = try? value.decode([ITFValue].self) {
      self = .list(list)
      return
    }
    let fields = try value.decode([String: ITFValue].self)
    if let number = fields["#bigint"] {
      guard fields.count == 1, case .string(let text) = number,
        let parsed = Int(text), String(parsed) == text
      else { throw VoiceITFError.invalid("integer") }
      self = .integer(parsed)
    } else if let values = fields["#set"] {
      guard fields.count == 1, case .list(let members) = values,
        members.enumerated().allSatisfy({ index, member in !members.prefix(index).contains(member) }
        )
      else { throw VoiceITFError.invalid("set") }
      self = .set(members)
    } else if let tuple = fields["#tup"] {
      guard fields.count == 1, tuple == .list([]) else { throw VoiceITFError.invalid("unit") }
      self = .unit
    } else if let tag = fields["tag"] {
      guard fields.count == 2, case .string(let name) = tag, !name.isEmpty,
        let payload = fields["value"]
      else { throw VoiceITFError.invalid("variant") }
      self = .variant(name, payload)
    } else {
      guard !fields.keys.contains(where: { $0.hasPrefix("#") }), fields["value"] == nil else {
        throw VoiceITFError.invalid("record")
      }
      self = .record(fields)
    }
  }

  static func decode(_ data: Data) throws -> ITFValue {
    try JSONDecoder().decode(Self.self, from: data)
  }
  func record(_ keys: Set<String>) throws -> [String: ITFValue] {
    guard case .record(let fields) = self, Set(fields.keys) == keys else {
      throw VoiceITFError.invalid("record fields: expected \(keys.sorted())")
    }
    return fields
  }
  func integer() throws -> Int {
    guard case .integer(let value) = self else { throw VoiceITFError.invalid("expected integer") }
    return value
  }
  func boolean() throws -> Bool {
    guard case .boolean(let value) = self else { throw VoiceITFError.invalid("expected boolean") }
    return value
  }
  func list() throws -> [ITFValue] {
    guard case .list(let value) = self else { throw VoiceITFError.invalid("expected list") }
    return value
  }
  func variant() throws -> (String, ITFValue) {
    guard case .variant(let name, let value) = self else {
      throw VoiceITFError.invalid("expected variant")
    }
    return (name, value)
  }
  func optional<T>(_ transform: (ITFValue) throws -> T) throws -> T? {
    let (tag, value) = try variant()
    switch tag {
    case "None":
      guard value == .unit else { throw VoiceITFError.invalid("None payload") }
      return nil
    case "Some": return try transform(value)
    default: throw VoiceITFError.invalid("optional tag \(tag)")
    }
  }
  static func optional<T>(_ value: T?, _ transform: (T) throws -> ITFValue) rethrows -> ITFValue {
    guard let value else { return .variant("None", .unit) }
    return try .variant("Some", transform(value))
  }
}

enum VoiceITFError: Error, CustomStringConvertible {
  case invalid(String)
  var description: String {
    switch self {
    case .invalid(let message): return message
    }
  }
}

struct VoiceITFIdentities {
  enum Namespace: Int {
    case input = 1
    case response, epoch, session, incarnation, publisher, proposal
  }
  func uuid(_ namespace: Namespace, _ symbol: Int) throws -> UUID {
    guard (1...2).contains(symbol) else {
      throw VoiceITFError.invalid("symbol outside 1...2: \(symbol)")
    }
    guard
      let value = UUID(
        uuidString: String(format: "%08x-0000-0000-0000-%012x", namespace.rawValue, symbol))
    else {
      throw VoiceITFError.invalid("symbol UUID")
    }
    return value
  }
  func symbol(_ namespace: Namespace, _ value: UUID) throws -> Int {
    for symbol in 1...2 where try uuid(namespace, symbol) == value { return symbol }
    throw VoiceITFError.invalid("unknown \(namespace) identity")
  }
}

struct VoiceITFDocument: Decodable {
  let vars: [String]
  let states: [VoiceITFFrame]
  private enum CodingKeys: String, CodingKey { case vars, states }
  init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    vars = try container.decode([String].self, forKey: .vars).map(voiceITFVariable)
    states = try container.decode([VoiceITFFrame].self, forKey: .states)
    guard vars.count == 4, Set(vars) == ["commands", "event", "previous", "state"], !states.isEmpty
    else {
      throw VoiceITFError.invalid("trace variables or empty states")
    }
  }
}

struct VoiceITFFrame: Decodable {
  let values: [String: ITFValue]
  private struct Key: CodingKey {
    let stringValue: String
    var intValue: Int? { nil }
    init?(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { return nil }
  }
  init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: Key.self)
    var fields: [String: ITFValue] = [:]
    for key in container.allKeys where key.stringValue != "#meta" {
      let name = try voiceITFVariable(key.stringValue)
      guard fields[name] == nil else { throw VoiceITFError.invalid("duplicate trace variable") }
      fields[name] = try container.decode(ITFValue.self, forKey: key)
    }
    values = fields
  }
}

/// Quint preserves this imported machine qualification in generated test traces.
private func voiceITFVariable(_ name: String) throws -> String {
  let names: Set<String> = ["commands", "event", "previous", "state"]
  if names.contains(name) { return name }
  let prefix = "VoiceOutputTest::VoiceOutputMachine::"
  if name.hasPrefix(prefix) {
    let local = String(name.dropFirst(prefix.count))
    if names.contains(local) { return local }
  }
  throw VoiceITFError.invalid("unknown trace variable \(name)")
}
