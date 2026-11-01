import AppKit
import Foundation
import Vision

struct PaletteEntry { let y: UInt8; let cr: UInt8; let cb: UInt8; let alpha: UInt8 }
struct ObjectData { var width = 0; var height = 0; var rle = [UInt8]() }
struct Placement { let id: Int; let x: Int; let y: Int }
struct Presentation { let pts: UInt32; let paletteID: Int; let width: Int; let height: Int; let placements: [Placement] }
struct Cue { let start: Double; let end: Double; let text: String }

func u16(_ bytes: [UInt8], _ offset: Int) -> Int { Int(bytes[offset]) << 8 | Int(bytes[offset + 1]) }
func u24(_ bytes: [UInt8], _ offset: Int) -> Int { Int(bytes[offset]) << 16 | Int(bytes[offset + 1]) << 8 | Int(bytes[offset + 2]) }
func u32(_ bytes: [UInt8], _ offset: Int) -> UInt32 { UInt32(bytes[offset]) << 24 | UInt32(bytes[offset + 1]) << 16 | UInt32(bytes[offset + 2]) << 8 | UInt32(bytes[offset + 3]) }

func timestamp(_ seconds: Double) -> String {
  let total = max(0, Int((seconds * 1000).rounded()))
  return String(format: "%02d:%02d:%02d,%03d", total / 3_600_000, (total / 60_000) % 60, (total / 1000) % 60, total % 1000)
}

func rgba(_ entry: PaletteEntry) -> (UInt8, UInt8, UInt8, UInt8) {
  let y = Double(entry.y), cr = Double(entry.cr) - 128, cb = Double(entry.cb) - 128
  func clamp(_ value: Double) -> UInt8 { UInt8(max(0, min(255, Int(value.rounded())))) }
  return (clamp(y + 1.402 * cr), clamp(y - 0.344136 * cb - 0.714136 * cr), clamp(y + 1.772 * cb), entry.alpha)
}

func decode(_ object: ObjectData, palette: [UInt8: PaletteEntry]) -> [UInt8]? {
  guard object.width > 0, object.height > 0 else { return nil }
  var pixels = Array(repeating: UInt8(0), count: object.width * object.height * 4)
  var source = 0, x = 0, y = 0
  func paint(_ length: Int, _ color: UInt8) {
    guard y < object.height else { return }
    let rgbaValue = palette[color].map(rgba) ?? (UInt8(0), UInt8(0), UInt8(0), UInt8(0))
    for _ in 0..<min(length, object.width - x) {
      let index = (y * object.width + x) * 4
      pixels[index] = rgbaValue.0; pixels[index + 1] = rgbaValue.1; pixels[index + 2] = rgbaValue.2; pixels[index + 3] = rgbaValue.3
      x += 1
    }
  }
  while source < object.rle.count && y < object.height {
    let first = object.rle[source]; source += 1
    if first != 0 { paint(1, first); continue }
    guard source < object.rle.count else { break }
    let control = object.rle[source]; source += 1
    if control == 0 { x = 0; y += 1; continue }
    var length = Int(control & 0x3f)
    if control & 0x40 != 0 {
      guard source < object.rle.count else { break }
      length = (length << 8) | Int(object.rle[source]); source += 1
    }
    var color: UInt8 = 0
    if control & 0x80 != 0 {
      guard source < object.rle.count else { break }
      color = object.rle[source]; source += 1
    }
    paint(length, color)
  }
  return pixels
}

func recognize(_ pixels: [UInt8], width: Int, height: Int) -> String {
  var mutable = pixels
  return mutable.withUnsafeMutableBytes { raw in
    guard let context = CGContext(data: raw.baseAddress, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue), let image = context.makeImage() else { return "" }
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    request.recognitionLanguages = ["fr-FR", "en-US"]
    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    do { try handler.perform([request]) } catch { return "" }
    let lines = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
    return lines.joined(separator: "\n")
  }
}

guard CommandLine.arguments.count == 3 else {
  fputs("Usage: pgs_ocr_to_srt.swift input.sup output.srt\n", stderr); exit(64)
}
let sourceURL = URL(fileURLWithPath: CommandLine.arguments[1])
let outputURL = URL(fileURLWithPath: CommandLine.arguments[2])
let bytes = [UInt8](try Data(contentsOf: sourceURL))
var palettes = [Int: [UInt8: PaletteEntry]]()
var objects = [Int: ObjectData]()
var current: Presentation?
var cues = [Cue]()

func emit(until nextPTS: UInt32) {
  guard let page = current else { return }
  let start = Double(page.pts) / 90_000
  let end = Double(nextPTS) / 90_000
  guard end > start + 0.15 else { return }
  let palette = palettes[page.paletteID] ?? [:]
  let text = page.placements.compactMap { placement -> String? in
    guard let object = objects[placement.id], let pixels = decode(object, palette: palette) else { return nil }
    let value = recognize(pixels, width: object.width, height: object.height)
    return value.isEmpty ? nil : value
  }.joined(separator: "\n")
  if !text.isEmpty { cues.append(Cue(start: start, end: end, text: text)) }
}

var offset = 0
while offset + 13 <= bytes.count {
  guard bytes[offset] == 0x50, bytes[offset + 1] == 0x47 else { offset += 1; continue }
  let pts = u32(bytes, offset + 2)
  let type = bytes[offset + 10]
  let length = u16(bytes, offset + 11)
  let bodyStart = offset + 13
  guard bodyStart + length <= bytes.count else { break }
  let body = Array(bytes[bodyStart..<(bodyStart + length)])
  offset = bodyStart + length
  switch type {
  case 0x14 where body.count >= 2:
    let id = Int(body[0]); var entries = palettes[id] ?? [:]; var index = 2
    while index + 4 < body.count { entries[body[index]] = PaletteEntry(y: body[index + 1], cr: body[index + 2], cb: body[index + 3], alpha: body[index + 4]); index += 5 }
    palettes[id] = entries
  case 0x15 where body.count >= 4:
    let id = u16(body, 0); let first = body[3] & 0x80 != 0; var object = objects[id] ?? ObjectData()
    var index = 4
    if first, body.count >= 11 { object.width = u16(body, 7); object.height = u16(body, 9); object.rle = []; index = 11 }
    if index < body.count { object.rle += body[index...] }
    objects[id] = object
  case 0x16 where body.count >= 11:
    emit(until: pts)
    let width = u16(body, 0), height = u16(body, 2), paletteID = Int(body[9]), count = Int(body[10])
    var placements = [Placement](), index = 11
    for _ in 0..<count where index + 7 < body.count {
      let id = u16(body, index), flags = body[index + 3], x = u16(body, index + 4), y = u16(body, index + 6)
      placements.append(Placement(id: id, x: x, y: y)); index += flags & 0x80 != 0 ? 16 : 8
    }
    current = placements.isEmpty ? nil : Presentation(pts: pts, paletteID: paletteID, width: width, height: height, placements: placements)
  default: break
  }
}
if let last = current { emit(until: last.pts + 360_000) }
let rendered = cues.enumerated().map { index, cue in "\(index + 1)\n\(timestamp(cue.start)) --> \(timestamp(cue.end))\n\(cue.text)\n" }.joined(separator: "\n")
try rendered.write(to: outputURL, atomically: true, encoding: .utf8)
print("\(cues.count) cues written to \(outputURL.path)")
