#!/usr/bin/env swift
//
// Measure how far apart a recording's two audio tracks actually are.
//
// `slickshot probe --track-offsets` reports where each track begins and ends,
// which catches gross problems but says nothing about whether a given *sound*
// lands at the same instant in both. This does: it decodes both tracks to PCM,
// builds an amplitude envelope for each, and cross-correlates them.
//
// Intended for a recording made with system audio and microphone on, while a
// click track (a repeating short transient) plays through the speakers next to
// the microphone -- both tracks then hear the same clicks, and a well-synced
// pair correlates at a lag of about zero.
//
//     swift scripts/check-track-sync.swift /path/to/recording.mp4
//
// Uses only AVFoundation, so it needs nothing installed beyond Xcode's command
// line tools -- deliberately, rather than pulling in ffmpeg just to test.

import AVFoundation
import Foundation

// Envelope resolution. 1ms buckets are finer than the ~21ms AAC packet grid,
// so quantisation in the container cannot hide a real offset.
let bucketMs = 1.0
// How far to search in each direction. Beyond this it is not a sync problem.
let maxLagMs = 1000.0
// Plenty for locating clicks, and keeps the correlation quick.
let sampleRate = 8000.0

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(2)
}

/// Decodes one audio track to mono float samples at `sampleRate`.
func decodeTrack(asset: AVAsset, track: AVAssetTrack) throws -> [Float] {
    let reader = try AVAssetReader(asset: asset)
    let settings: [String: Any] = [
        AVFormatIDKey: kAudioFormatLinearPCM,
        AVLinearPCMBitDepthKey: 32,
        AVLinearPCMIsFloatKey: true,
        AVLinearPCMIsNonInterleaved: false,
        AVSampleRateKey: sampleRate,
        AVNumberOfChannelsKey: 1,
    ]
    let output = AVAssetReaderTrackOutput(track: track, outputSettings: settings)
    guard reader.canAdd(output) else { throw NSError(domain: "sync", code: 1) }
    reader.add(output)
    reader.startReading()

    var samples: [Float] = []
    while let buffer = output.copyNextSampleBuffer() {
        guard let block = CMSampleBufferGetDataBuffer(buffer) else { continue }
        var length = 0
        var pointer: UnsafeMutablePointer<Int8>?
        guard CMBlockBufferGetDataPointer(
            block, atOffset: 0, lengthAtOffsetOut: nil,
            totalLengthOut: &length, dataPointerOut: &pointer
        ) == kCMBlockBufferNoErr, let raw = pointer else { continue }
        raw.withMemoryRebound(to: Float.self, capacity: length / 4) { floats in
            samples.append(contentsOf: UnsafeBufferPointer(start: floats, count: length / 4))
        }
    }
    reader.cancelReading()
    return samples
}

/// Per-bucket peak amplitude -- a cheap stand-in for loudness that keeps
/// transients sharp, which is what makes clicks locatable.
func envelope(_ samples: [Float]) -> [Double] {
    let perBucket = max(1, Int(sampleRate * bucketMs / 1000.0))
    var out: [Double] = []
    out.reserveCapacity(samples.count / perBucket + 1)
    var i = 0
    while i < samples.count {
        let end = min(i + perBucket, samples.count)
        var peak: Float = 0
        for j in i..<end { peak = max(peak, abs(samples[j])) }
        out.append(Double(peak))
        i = end
    }
    return out
}

/// Zero-mean, unit-norm, so the correlation is a real similarity score and not
/// just a reflection of which track was recorded louder.
func normalise(_ env: [Double]) -> [Double] {
    guard !env.isEmpty else { return [] }
    let mean = env.reduce(0, +) / Double(env.count)
    let centred = env.map { $0 - mean }
    let norm = sqrt(centred.reduce(0) { $0 + $1 * $1 })
    guard norm > 0 else { return [] }
    return centred.map { $0 / norm }
}

/// The lag, in buckets, at which `b` best matches `a`. Positive means `b` is
/// late relative to `a`.
func bestLag(_ a: [Double], _ b: [Double], maxLag: Int) -> (lag: Int, score: Double)? {
    var best: (Int, Double)? = nil
    for lag in -maxLag...maxLag {
        let x: ArraySlice<Double>
        let y: ArraySlice<Double>
        if lag >= 0 {
            guard lag < a.count else { continue }
            x = a[lag...]
            y = b[..<min(b.count, a.count - lag)]
        } else {
            let shift = -lag
            guard shift < b.count else { continue }
            y = b[shift...]
            x = a[..<min(a.count, b.count - shift)]
        }
        let n = min(x.count, y.count)
        // A lag that leaves little overlap is not comparable.
        guard n >= 100 else { continue }
        var score = 0.0
        let xs = Array(x.prefix(n)), ys = Array(y.prefix(n))
        for i in 0..<n { score += xs[i] * ys[i] }
        if best == nil || score > best!.1 { best = (lag, score) }
    }
    return best.map { (lag: $0.0, score: $0.1) }
}

// -- main ------------------------------------------------------------------

let args = CommandLine.arguments
guard args.count == 2 else {
    fail("usage: swift scripts/check-track-sync.swift <recording.mp4>")
}
let url = URL(fileURLWithPath: args[1])
guard FileManager.default.fileExists(atPath: url.path) else {
    fail("no such file: \(url.path)")
}

let asset = AVURLAsset(url: url)
let tracks = asset.tracks(withMediaType: .audio)
print("audio tracks: \(tracks.count)")
guard tracks.count >= 2 else {
    fail("need two audio tracks -- record with both system audio and the microphone on")
}

var envelopes: [[Double]] = []
for (i, track) in tracks.prefix(2).enumerated() {
    let samples: [Float]
    do { samples = try decodeTrack(asset: asset, track: track) }
    catch { fail("couldn't decode track \(i): \(error)") }
    let env = envelope(samples)
    let peak = env.max() ?? 0
    print(String(format: "track %d: %d buckets (%.2fs), peak=%.4f",
                 i, env.count, Double(env.count) * bucketMs / 1000.0, peak))
    if peak < 0.001 {
        print("  ...that track is essentially silent")
    }
    envelopes.append(normalise(env))
}

guard !envelopes[0].isEmpty, !envelopes[1].isEmpty else {
    fail("a track is silent -- nothing to correlate")
}

guard let result = bestLag(envelopes[0], envelopes[1], maxLag: Int(maxLagMs / bucketMs)) else {
    fail("the tracks do not overlap enough to compare")
}

let offsetMs = Double(result.lag) * bucketMs
print(String(format: "\nbest alignment: track 1 is %+.1fms relative to track 0", offsetMs))
print(String(format: "correlation: %.3f", result.score))

if result.score < 0.15 {
    print("""

    WEAK correlation -- the two tracks may not have heard the same sound.
    Play a click track through the speakers, next to the microphone, for the
    whole recording.
    """)
    exit(2)
}
// What counts as good needs to account for the measurement itself. The click
// reaches the system-audio tap before the DAC, but reaches the microphone only
// after speaker output latency, a few feet of air and the input device's own
// buffering -- tens of milliseconds that are physics, not a bug in the
// recorder. So this cannot resolve a true 20ms; what it can do is tell a
// correctly-synced pair apart from a broken one, which drifts by hundreds.
if abs(offsetMs) <= 50 {
    print("PASS -- \(String(format: "%.1f", abs(offsetMs)))ms, inside the acoustic loop's own latency budget")
    exit(0)
}
print("""
OUT OF TOLERANCE -- more than 50ms apart, which is past what speaker and
microphone latency alone explain. Check the clock conversion in
src-tauri/screen_record.m (captureOutput:didOutputSampleBuffer:).
""")
exit(1)
