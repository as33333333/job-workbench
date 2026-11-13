// 用 macOS 自带 Vision 对 PDF 逐页 OCR（不引入 npm 依赖，也不上传文件到第三方）
// 用法: swift scripts/pdf-ocr.swift <pdf 路径> [最多页数，默认 15]
import Foundation
import PDFKit
import Vision
import CoreGraphics

let args = CommandLine.arguments
guard args.count >= 2 else {
  FileHandle.standardError.write("usage: pdf-ocr <file.pdf> [maxPages]\n".data(using: .utf8)!)
  exit(2)
}
let maxPages = args.count > 2 ? (Int(args[2]) ?? 15) : 15
guard let doc = PDFDocument(url: URL(fileURLWithPath: args[1])), doc.pageCount > 0 else {
  FileHandle.standardError.write("无法打开 PDF\n".data(using: .utf8)!)
  exit(3)
}

let total = min(doc.pageCount, max(1, maxPages))
var out = ""
for i in 0..<total {
  guard let page = doc.page(at: i) else { continue }
  let bounds = page.bounds(for: .mediaBox)
  let scale: CGFloat = 2.0
  let w = Int(bounds.width * scale), h = Int(bounds.height * scale)
  if w <= 0 || h <= 0 { continue }
  guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                            space: CGColorSpaceCreateDeviceRGB(),
                            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { continue }
  ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
  ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
  ctx.scaleBy(x: scale, y: scale)
  page.draw(with: .mediaBox, to: ctx)
  guard let cg = ctx.makeImage() else { continue }

  let request = VNRecognizeTextRequest()
  request.recognitionLevel = .accurate
  request.usesLanguageCorrection = true
  request.recognitionLanguages = ["zh-Hans", "en-US"]
  let handler = VNImageRequestHandler(cgImage: cg, options: [:])
  do { try handler.perform([request]) } catch { continue }

  let rows: [(CGFloat, CGFloat, String)] = (request.results ?? []).compactMap { obs in
    guard let text = obs.topCandidates(1).first?.string, !text.isEmpty else { return nil }
    return (obs.boundingBox.midY, obs.boundingBox.minX, text)
  }.sorted { a, b in abs(a.0 - b.0) > 0.01 ? a.0 > b.0 : a.1 < b.1 }

  out += rows.map { $0.2 }.joined(separator: "\n") + "\n"
}
print(out)
