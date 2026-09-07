// Native macOS screen recording via ScreenCaptureKit + AVFoundation, exposed
// to Rust through a tiny C ABI -- the same split as vision_ocr.m: this file
// owns every Objective-C object, and the Rust side (src/record/macos.rs) only
// ever holds an opaque pointer.
//
// ScreenCaptureKit feeds an AVAssetWriter directly, so H.264 encoding is
// hardware-accelerated and the region crop happens before a single frame
// reaches us. System audio rides the same SCStream (macOS 13+); the
// microphone is a separate AVCaptureSession, whose samples are converted onto
// the host clock so both tracks share the stream's timeline.
//
// Compiled by build.rs with the `cc` crate, macOS only.

#import <Foundation/Foundation.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <AVFoundation/AVFoundation.h>
#import <CoreMedia/CoreMedia.h>
#import <CoreVideo/CoreVideo.h>
#import <AppKit/AppKit.h>

// Same ownership contract as vision_ocr.m: malloc'd UTF-8, freed by Rust.
static char *tas_rec_copy_cstr(NSString *s) {
    const char *u = [s UTF8String];
    if (!u) {
        return NULL;
    }
    size_t n = strlen(u) + 1;
    char *out = malloc(n);
    if (out) {
        memcpy(out, u, n);
    }
    return out;
}

void tas_record_free(char *p) {
    if (p) {
        free(p);
    }
}

static void tas_set_err(char **err_out, NSString *msg) {
    if (err_out) {
        *err_out = tas_rec_copy_cstr(msg);
    }
}

// Bit flags reported back by tas_record_flags.
enum {
    TAS_REC_FLAG_MIC_DENIED = 1 << 0,
    TAS_REC_FLAG_MIC_FAILED = 1 << 1,
};

API_AVAILABLE(macos(13.0))
@interface TasRecorder : NSObject <SCStreamOutput, SCStreamDelegate, AVCaptureAudioDataOutputSampleBufferDelegate>

@property(nonatomic, strong) SCStream *stream;
@property(nonatomic, strong) AVAssetWriter *writer;
@property(nonatomic, strong) AVAssetWriterInput *videoInput;
@property(nonatomic, strong) AVAssetWriterInputPixelBufferAdaptor *adaptor;
@property(nonatomic, strong) AVAssetWriterInput *systemAudioInput;
@property(nonatomic, strong) AVAssetWriterInput *micInput;
@property(nonatomic, strong) AVCaptureSession *micSession;
@property(nonatomic, strong) NSURL *outURL;
@property(nonatomic, strong) dispatch_queue_t sampleQueue;

@property(nonatomic, assign) BOOL sessionStarted;
@property(nonatomic, assign) CMTime firstPTS;
@property(nonatomic, assign) NSTimeInterval startedAt;
@property(nonatomic, assign) int flags;
@end

@implementation TasRecorder

- (instancetype)init {
    self = [super init];
    if (self) {
        _sampleQueue = dispatch_queue_create("dev.tuanp.slickshot.record", DISPATCH_QUEUE_SERIAL);
        _firstPTS = kCMTimeInvalid;
        _sessionStarted = NO;
        _flags = 0;
    }
    return self;
}

// The writer session is anchored on the first *video* sample so audio and
// video share one zero point; audio that arrives earlier is dropped rather
// than shifting the whole timeline backwards.
- (void)startSessionIfNeeded:(CMTime)pts {
    if (self.sessionStarted) {
        return;
    }
    self.firstPTS = pts;
    [self.writer startSessionAtSourceTime:pts];
    self.sessionStarted = YES;
}

- (void)stream:(SCStream *)stream
    didOutputSampleBuffer:(CMSampleBufferRef)sampleBuffer
                   ofType:(SCStreamOutputType)type {
    if (!CMSampleBufferIsValid(sampleBuffer)) {
        return;
    }
    if (self.writer.status == AVAssetWriterStatusFailed) {
        return;
    }

    CMTime pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer);

    if (type == SCStreamOutputTypeScreen) {
        // A screen sample can be "complete" but carry no new pixels (nothing
        // on screen changed); those have no image buffer and must be skipped.
        CVImageBufferRef image = CMSampleBufferGetImageBuffer(sampleBuffer);
        if (!image) {
            return;
        }
        [self startSessionIfNeeded:pts];
        if (self.videoInput.isReadyForMoreMediaData) {
            [self.adaptor appendPixelBuffer:image withPresentationTime:pts];
        }
        return;
    }

    if (type == SCStreamOutputTypeAudio) {
        if (!self.sessionStarted || !self.systemAudioInput.isReadyForMoreMediaData) {
            return;
        }
        [self.systemAudioInput appendSampleBuffer:sampleBuffer];
    }
}

// Microphone samples come from AVCaptureSession, which stamps them with its
// own synchronization clock; ScreenCaptureKit stamps with the host clock. The
// two are converted between explicitly, which is exact and cannot drift.
//
// An earlier version instead measured the gap against the last video frame's
// timestamp. That was wrong for a reason worth recording: SCStream only
// delivers a frame when the screen actually changes, so on a still region the
// "current" video time can be hundreds of milliseconds stale, and every
// microphone buffer was stamped that far into the past. It showed up as the
// microphone track ending ~390ms before the system-audio track on a static
// 5-second recording.
- (void)captureOutput:(AVCaptureOutput *)output
    didOutputSampleBuffer:(CMSampleBufferRef)sampleBuffer
           fromConnection:(AVCaptureConnection *)connection {
    if (!self.sessionStarted || !self.micInput.isReadyForMoreMediaData) {
        return;
    }
    if (self.writer.status == AVAssetWriterStatusFailed) {
        return;
    }

    CMTime pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer);
    if (!CMTIME_IS_NUMERIC(pts)) {
        return;
    }

    // Both clocks are usually the host clock already, in which case this is
    // the identity; it matters for capture devices that run their own.
    CMClockRef micClock = self.micSession.synchronizationClock;
    CMTime adjusted =
        micClock ? CMSyncConvertTime(pts, micClock, CMClockGetHostTimeClock()) : pts;
    if (!CMTIME_IS_NUMERIC(adjusted)) {
        return;
    }
    if (CMTIME_COMPARE_INLINE(adjusted, <, self.firstPTS)) {
        return;
    }

    CMSampleBufferRef retimed = NULL;
    CMSampleTimingInfo timing = {0};
    timing.duration = CMSampleBufferGetDuration(sampleBuffer);
    timing.presentationTimeStamp = adjusted;
    timing.decodeTimeStamp = kCMTimeInvalid;
    OSStatus status =
        CMSampleBufferCreateCopyWithNewTiming(kCFAllocatorDefault, sampleBuffer, 1, &timing, &retimed);
    if (status != noErr || !retimed) {
        return;
    }
    [self.micInput appendSampleBuffer:retimed];
    CFRelease(retimed);
}

- (void)stream:(SCStream *)stream didStopWithError:(NSError *)error {
    // Nothing to do beyond letting the writer finish what it already has:
    // tas_record_stop reports whatever landed on disk.
}

@end

// Rounded to even: H.264 requires even dimensions, and an odd request
// otherwise fails deep inside the encoder with an opaque error.
static size_t tas_even(double v) {
    long n = lround(v);
    if (n < 2) {
        return 2;
    }
    return (size_t)(n - (n % 2));
}

// Starts a recording. `x/y/w/h` are in points within the display's own
// coordinate space (origin at its top-left); `scale` converts to the pixel
// dimensions the file is written at. Returns an opaque session or NULL.
void *tas_record_start(uint32_t display_id,
                       double x_pt,
                       double y_pt,
                       double w_pt,
                       double h_pt,
                       double scale,
                       uint32_t fps,
                       bool cursor,
                       bool system_audio,
                       bool microphone,
                       const char *out_path,
                       char **err_out) {
    if (err_out) {
        *err_out = NULL;
    }
    if (@available(macOS 13.0, *)) {
    } else {
        tas_set_err(err_out, @"screen recording needs macOS 13 or newer");
        return NULL;
    }

    if (@available(macOS 13.0, *)) {
        @autoreleasepool {
            __block SCDisplay *target = nil;
            dispatch_semaphore_t sem = dispatch_semaphore_create(0);
            __block NSError *contentError = nil;

            [SCShareableContent
                getShareableContentWithCompletionHandler:^(SCShareableContent *content, NSError *error) {
                  if (error) {
                      contentError = error;
                  } else {
                      for (SCDisplay *d in content.displays) {
                          if (d.displayID == display_id) {
                              target = d;
                              break;
                          }
                      }
                      if (!target && content.displays.count > 0) {
                          target = content.displays.firstObject;
                      }
                  }
                  dispatch_semaphore_signal(sem);
                }];

            // Screen Recording permission surfaces here as an error (or as an
            // empty display list) rather than as a prompt we can wait on.
            if (dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, 10 * NSEC_PER_SEC)) != 0) {
                tas_set_err(err_out, @"timed out asking macOS what is on screen");
                return NULL;
            }
            if (contentError) {
                tas_set_err(err_out,
                            [NSString stringWithFormat:@"%@ -- check Screen Recording permission in "
                                                       @"System Settings > Privacy & Security",
                                                       contentError.localizedDescription]);
                return NULL;
            }
            if (!target) {
                tas_set_err(err_out, @"no display is available to record");
                return NULL;
            }

            TasRecorder *rec = [[TasRecorder alloc] init];
            rec.outURL = [NSURL fileURLWithPath:[NSString stringWithUTF8String:out_path]];
            [[NSFileManager defaultManager] removeItemAtURL:rec.outURL error:nil];

            NSError *writerError = nil;
            rec.writer = [AVAssetWriter assetWriterWithURL:rec.outURL
                                                  fileType:AVFileTypeMPEG4
                                                     error:&writerError];
            if (!rec.writer) {
                tas_set_err(err_out, writerError ? writerError.localizedDescription
                                                 : @"couldn't create the movie file");
                return NULL;
            }

            size_t px_w = tas_even(w_pt * scale);
            size_t px_h = tas_even(h_pt * scale);

            NSDictionary *videoSettings = @{
                AVVideoCodecKey : AVVideoCodecTypeH264,
                AVVideoWidthKey : @(px_w),
                AVVideoHeightKey : @(px_h),
                AVVideoCompressionPropertiesKey : @{
                    AVVideoExpectedSourceFrameRateKey : @(fps),
                    AVVideoMaxKeyFrameIntervalKey : @(fps * 2),
                },
            };
            rec.videoInput = [AVAssetWriterInput assetWriterInputWithMediaType:AVMediaTypeVideo
                                                               outputSettings:videoSettings];
            rec.videoInput.expectsMediaDataInRealTime = YES;
            rec.adaptor = [AVAssetWriterInputPixelBufferAdaptor
                assetWriterInputPixelBufferAdaptorWithAssetWriterInput:rec.videoInput
                                            sourcePixelBufferAttributes:@{
                                              (NSString *)kCVPixelBufferPixelFormatTypeKey :
                                                  @(kCVPixelFormatType_32BGRA),
                                              (NSString *)kCVPixelBufferWidthKey : @(px_w),
                                              (NSString *)kCVPixelBufferHeightKey : @(px_h),
                                            }];
            if ([rec.writer canAddInput:rec.videoInput]) {
                [rec.writer addInput:rec.videoInput];
            } else {
                tas_set_err(err_out, @"the movie file rejected its video track");
                return NULL;
            }

            NSDictionary *audioSettings = @{
                AVFormatIDKey : @(kAudioFormatMPEG4AAC),
                AVSampleRateKey : @48000,
                AVNumberOfChannelsKey : @2,
                AVEncoderBitRateKey : @128000,
            };

            if (system_audio) {
                rec.systemAudioInput =
                    [AVAssetWriterInput assetWriterInputWithMediaType:AVMediaTypeAudio
                                                       outputSettings:audioSettings];
                rec.systemAudioInput.expectsMediaDataInRealTime = YES;
                if ([rec.writer canAddInput:rec.systemAudioInput]) {
                    [rec.writer addInput:rec.systemAudioInput];
                } else {
                    rec.systemAudioInput = nil;
                }
            }

            if (microphone) {
                // Asked synchronously: starting the stream and only then
                // discovering the mic is denied would silently produce a
                // recording missing the track the user asked for.
                AVAuthorizationStatus status =
                    [AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio];
                if (status == AVAuthorizationStatusNotDetermined) {
                    dispatch_semaphore_t micSem = dispatch_semaphore_create(0);
                    [AVCaptureDevice requestAccessForMediaType:AVMediaTypeAudio
                                             completionHandler:^(BOOL granted) {
                                               (void)granted;
                                               dispatch_semaphore_signal(micSem);
                                             }];
                    dispatch_semaphore_wait(micSem,
                                            dispatch_time(DISPATCH_TIME_NOW, 30 * NSEC_PER_SEC));
                    status = [AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio];
                }

                if (status != AVAuthorizationStatusAuthorized) {
                    rec.flags |= TAS_REC_FLAG_MIC_DENIED;
                } else {
                    AVCaptureDevice *device =
                        [AVCaptureDevice defaultDeviceWithMediaType:AVMediaTypeAudio];
                    NSError *micError = nil;
                    AVCaptureDeviceInput *micInputDev =
                        device ? [AVCaptureDeviceInput deviceInputWithDevice:device error:&micError]
                               : nil;
                    if (!micInputDev) {
                        rec.flags |= TAS_REC_FLAG_MIC_FAILED;
                    } else {
                        rec.micInput =
                            [AVAssetWriterInput assetWriterInputWithMediaType:AVMediaTypeAudio
                                                              outputSettings:audioSettings];
                        rec.micInput.expectsMediaDataInRealTime = YES;
                        if ([rec.writer canAddInput:rec.micInput]) {
                            [rec.writer addInput:rec.micInput];

                            rec.micSession = [[AVCaptureSession alloc] init];
                            if ([rec.micSession canAddInput:micInputDev]) {
                                [rec.micSession addInput:micInputDev];
                            }
                            AVCaptureAudioDataOutput *micOut =
                                [[AVCaptureAudioDataOutput alloc] init];
                            [micOut setSampleBufferDelegate:rec queue:rec.sampleQueue];
                            if ([rec.micSession canAddOutput:micOut]) {
                                [rec.micSession addOutput:micOut];
                            }
                        } else {
                            rec.micInput = nil;
                            rec.flags |= TAS_REC_FLAG_MIC_FAILED;
                        }
                    }
                }
            }

            SCContentFilter *filter = [[SCContentFilter alloc] initWithDisplay:target
                                                             excludingWindows:@[]];

            SCStreamConfiguration *config = [[SCStreamConfiguration alloc] init];
            config.width = px_w;
            config.height = px_h;
            config.sourceRect = CGRectMake(x_pt, y_pt, w_pt, h_pt);
            config.minimumFrameInterval = CMTimeMake(1, (int32_t)(fps > 0 ? fps : 30));
            config.showsCursor = cursor;
            config.pixelFormat = kCVPixelFormatType_32BGRA;
            config.queueDepth = 6;
            // Without this a region whose aspect differs from the display's is
            // letterboxed into the output instead of filling it.
            config.scalesToFit = NO;
            if (system_audio) {
                config.capturesAudio = YES;
                config.excludesCurrentProcessAudio = YES;
                config.sampleRate = 48000;
                config.channelCount = 2;
            }

            NSError *streamError = nil;
            rec.stream = [[SCStream alloc] initWithFilter:filter configuration:config delegate:rec];
            if (![rec.stream addStreamOutput:rec
                                        type:SCStreamOutputTypeScreen
                          sampleHandlerQueue:rec.sampleQueue
                                       error:&streamError]) {
                tas_set_err(err_out, streamError ? streamError.localizedDescription
                                                 : @"couldn't attach the screen capture output");
                return NULL;
            }
            if (system_audio && rec.systemAudioInput) {
                [rec.stream addStreamOutput:rec
                                       type:SCStreamOutputTypeAudio
                         sampleHandlerQueue:rec.sampleQueue
                                      error:nil];
            }

            if (![rec.writer startWriting]) {
                tas_set_err(err_out, rec.writer.error ? rec.writer.error.localizedDescription
                                                      : @"the movie file wouldn't open for writing");
                return NULL;
            }

            __block NSError *startError = nil;
            dispatch_semaphore_t startSem = dispatch_semaphore_create(0);
            [rec.stream startCaptureWithCompletionHandler:^(NSError *error) {
              startError = error;
              dispatch_semaphore_signal(startSem);
            }];
            if (dispatch_semaphore_wait(startSem, dispatch_time(DISPATCH_TIME_NOW, 10 * NSEC_PER_SEC)) != 0) {
                tas_set_err(err_out, @"timed out starting the screen capture");
                return NULL;
            }
            if (startError) {
                tas_set_err(err_out, startError.localizedDescription);
                return NULL;
            }

            [rec.micSession startRunning];
            rec.startedAt = [NSDate timeIntervalSinceReferenceDate];
            return (void *)CFBridgingRetain(rec);
        }
    }
    return NULL;
}

double tas_record_elapsed(void *session) {
    if (!session) {
        return 0.0;
    }
    if (@available(macOS 13.0, *)) {
        TasRecorder *rec = (__bridge TasRecorder *)session;
        return [NSDate timeIntervalSinceReferenceDate] - rec.startedAt;
    }
    return 0.0;
}

int tas_record_flags(void *session) {
    if (!session) {
        return 0;
    }
    if (@available(macOS 13.0, *)) {
        TasRecorder *rec = (__bridge TasRecorder *)session;
        return rec.flags;
    }
    return 0;
}

// Stops and finalizes. Returns the output path (caller frees) or NULL.
char *tas_record_stop(void *session, char **err_out) {
    if (err_out) {
        *err_out = NULL;
    }
    if (!session) {
        tas_set_err(err_out, @"no recording is running");
        return NULL;
    }
    if (@available(macOS 13.0, *)) {
        @autoreleasepool {
            TasRecorder *rec = (TasRecorder *)CFBridgingRelease(session);

            dispatch_semaphore_t sem = dispatch_semaphore_create(0);
            [rec.stream stopCaptureWithCompletionHandler:^(NSError *stopError) {
              (void)stopError;
              dispatch_semaphore_signal(sem);
            }];
            dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC));
            [rec.micSession stopRunning];

            if (!rec.sessionStarted) {
                [rec.writer cancelWriting];
                tas_set_err(err_out, @"the recording ended before any frame arrived");
                return NULL;
            }

            [rec.videoInput markAsFinished];
            [rec.systemAudioInput markAsFinished];
            [rec.micInput markAsFinished];

            dispatch_semaphore_t finishSem = dispatch_semaphore_create(0);
            [rec.writer finishWritingWithCompletionHandler:^{
              dispatch_semaphore_signal(finishSem);
            }];
            dispatch_semaphore_wait(finishSem, dispatch_time(DISPATCH_TIME_NOW, 30 * NSEC_PER_SEC));

            if (rec.writer.status != AVAssetWriterStatusCompleted) {
                tas_set_err(err_out, rec.writer.error ? rec.writer.error.localizedDescription
                                                      : @"the recording didn't finish writing");
                return NULL;
            }
            return tas_rec_copy_cstr(rec.outURL.path);
        }
    }
    return NULL;
}

void tas_record_cancel(void *session) {
    if (!session) {
        return;
    }
    if (@available(macOS 13.0, *)) {
        @autoreleasepool {
            TasRecorder *rec = (TasRecorder *)CFBridgingRelease(session);
            dispatch_semaphore_t sem = dispatch_semaphore_create(0);
            [rec.stream stopCaptureWithCompletionHandler:^(NSError *stopError) {
              (void)stopError;
              dispatch_semaphore_signal(sem);
            }];
            dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC));
            [rec.micSession stopRunning];
            [rec.writer cancelWriting];
            [[NSFileManager defaultManager] removeItemAtURL:rec.outURL error:nil];
        }
    }
}

// "w\th\tduration_ms\tfps\thas_audio\taudio_tracks", caller frees.
char *tas_video_probe(const char *path, char **err_out) {
    if (err_out) {
        *err_out = NULL;
    }
    @autoreleasepool {
        NSURL *url = [NSURL fileURLWithPath:[NSString stringWithUTF8String:path]];
        AVURLAsset *asset = [AVURLAsset URLAssetWithURL:url options:nil];
        NSArray<AVAssetTrack *> *videoTracks = [asset tracksWithMediaType:AVMediaTypeVideo];
        if (videoTracks.count == 0) {
            tas_set_err(err_out, @"this file has no video track");
            return NULL;
        }
        AVAssetTrack *video = videoTracks.firstObject;
        CGSize size = CGSizeApplyAffineTransform(video.naturalSize, video.preferredTransform);
        double duration_ms = CMTimeGetSeconds(asset.duration) * 1000.0;
        float fps = video.nominalFrameRate;
        NSArray<AVAssetTrack *> *audioTracks = [asset tracksWithMediaType:AVMediaTypeAudio];

        return tas_rec_copy_cstr([NSString
            stringWithFormat:@"%.0f\t%.0f\t%.0f\t%.3f\t%d\t%lu", fabs(size.width), fabs(size.height),
                             duration_ms, fps, audioTracks.count > 0 ? 1 : 0,
                             (unsigned long)audioTracks.count]);
    }
}

// Debug aid for audio drift: one row per audio track, tab-separated as
// "index\tfirst_pts_ms\tlast_pts_ms\tsamples", rows separated by newlines.
//
// Two tracks recorded from one clock should start and end within a few
// milliseconds of each other; a growing gap between their last PTS is exactly
// what unresampled microphone drift looks like, and it is invisible in a
// waveform until the clip is minutes long.
char *tas_video_track_offsets(const char *path, char **err_out) {
    if (err_out) {
        *err_out = NULL;
    }
    @autoreleasepool {
        NSURL *url = [NSURL fileURLWithPath:[NSString stringWithUTF8String:path]];
        AVURLAsset *asset = [AVURLAsset URLAssetWithURL:url options:nil];
        NSArray<AVAssetTrack *> *tracks = [asset tracksWithMediaType:AVMediaTypeAudio];
        if (tracks.count == 0) {
            return tas_rec_copy_cstr(@"");
        }

        NSMutableArray<NSString *> *rows = [NSMutableArray array];
        for (NSUInteger i = 0; i < tracks.count; i++) {
            AVAssetTrack *track = tracks[i];
            NSError *error = nil;
            AVAssetReader *reader = [[AVAssetReader alloc] initWithAsset:asset error:&error];
            if (!reader) {
                tas_set_err(err_out, error ? error.localizedDescription
                                           : @"couldn't read this movie's audio");
                return NULL;
            }
            // No output settings: samples come back compressed, which is all
            // this needs -- only their timestamps are read, never the audio.
            AVAssetReaderTrackOutput *out =
                [AVAssetReaderTrackOutput assetReaderTrackOutputWithTrack:track outputSettings:nil];
            if (![reader canAddOutput:out]) {
                tas_set_err(err_out, @"couldn't read this movie's audio");
                return NULL;
            }
            [reader addOutput:out];
            [reader startReading];

            double first_ms = -1.0;
            double last_ms = -1.0;
            unsigned long long samples = 0;
            CMSampleBufferRef buffer = NULL;
            while ((buffer = [out copyNextSampleBuffer])) {
                CMTime pts = CMSampleBufferGetPresentationTimeStamp(buffer);
                if (CMTIME_IS_NUMERIC(pts)) {
                    double ms = CMTimeGetSeconds(pts) * 1000.0;
                    if (first_ms < 0.0) {
                        first_ms = ms;
                    }
                    // The last sample's *end*, so a track whose final buffer
                    // holds 1024 frames is not reported as ending 21ms early.
                    CMTime dur = CMSampleBufferGetDuration(buffer);
                    last_ms = CMTIME_IS_NUMERIC(dur) ? ms + CMTimeGetSeconds(dur) * 1000.0 : ms;
                }
                samples += (unsigned long long)CMSampleBufferGetNumSamples(buffer);
                CFRelease(buffer);
            }
            [reader cancelReading];

            [rows addObject:[NSString stringWithFormat:@"%lu\t%.3f\t%.3f\t%llu", (unsigned long)i,
                                                       first_ms, last_ms, samples]];
        }
        return tas_rec_copy_cstr([rows componentsJoinedByString:@"\n"]);
    }
}

// Writes a poster frame from a third of the way in, as a PNG.
bool tas_video_poster(const char *src, const char *dst, char **err_out) {
    if (err_out) {
        *err_out = NULL;
    }
    @autoreleasepool {
        NSURL *url = [NSURL fileURLWithPath:[NSString stringWithUTF8String:src]];
        AVURLAsset *asset = [AVURLAsset URLAssetWithURL:url options:nil];
        AVAssetImageGenerator *gen = [[AVAssetImageGenerator alloc] initWithAsset:asset];
        gen.appliesPreferredTrackTransform = YES;
        gen.requestedTimeToleranceBefore = CMTimeMakeWithSeconds(0.5, 600);
        gen.requestedTimeToleranceAfter = CMTimeMakeWithSeconds(0.5, 600);

        CMTime at = CMTimeMultiplyByFloat64(asset.duration, 0.33);
        NSError *error = nil;
        CGImageRef image = [gen copyCGImageAtTime:at actualTime:NULL error:&error];
        if (!image) {
            tas_set_err(err_out, error ? error.localizedDescription
                                       : @"couldn't read a frame for the thumbnail");
            return false;
        }

        NSBitmapImageRep *rep = [[NSBitmapImageRep alloc] initWithCGImage:image];
        CGImageRelease(image);
        NSData *png = [rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
        if (!png) {
            tas_set_err(err_out, @"couldn't encode the thumbnail");
            return false;
        }
        NSError *writeError = nil;
        BOOL ok = [png writeToFile:[NSString stringWithUTF8String:dst]
                           options:NSDataWritingAtomic
                             error:&writeError];
        if (!ok) {
            tas_set_err(err_out, writeError ? writeError.localizedDescription
                                            : @"couldn't write the thumbnail");
            return false;
        }
        return true;
    }
}

// -- Decode and transcode ---------------------------------------------------
//
// The editor's export path. Everything that touches pixels (crop, resize,
// speed, annotation compositing, censor) is Rust in `record/transform.rs`;
// these two only decode to BGRA, hand each frame over, and re-encode what
// comes back. That way the interesting work is written and tested once
// instead of three times, and each platform owns only its media stack.

// Opens a reader over `path`'s video track for `[start_s, end_s)`, configured
// to hand back plain BGRA. Returns nil and sets the error on failure.
// `start_s`/`end_s` are in-out: they come back clamped to the asset, so
// callers pacing their own output know where the range really ends.
static AVAssetReader *tas_open_video_reader(NSURL *url,
                                            double *start_s_inout,
                                            double *end_s_inout,
                                            AVAssetReaderTrackOutput **out_output,
                                            CGSize *out_size,
                                            char **err_out) {
    double start_s = start_s_inout ? *start_s_inout : 0.0;
    double end_s = end_s_inout ? *end_s_inout : 0.0;
    AVURLAsset *asset = [AVURLAsset URLAssetWithURL:url options:nil];
    NSArray<AVAssetTrack *> *tracks = [asset tracksWithMediaType:AVMediaTypeVideo];
    if (tracks.count == 0) {
        tas_set_err(err_out, @"this file has no video track");
        return nil;
    }
    AVAssetTrack *track = tracks.firstObject;

    NSError *error = nil;
    AVAssetReader *reader = [[AVAssetReader alloc] initWithAsset:asset error:&error];
    if (!reader) {
        tas_set_err(err_out, error ? error.localizedDescription : @"couldn't read that movie");
        return nil;
    }

    // Clamped to the asset: asking a reader for a range past the end makes it
    // fail outright rather than simply stopping early.
    double duration_s = CMTimeGetSeconds(asset.duration);
    if (end_s <= 0 || end_s > duration_s) {
        end_s = duration_s;
    }
    if (start_s < 0) {
        start_s = 0;
    }
    if (start_s >= end_s) {
        tas_set_err(err_out, @"that time range is empty");
        return nil;
    }
    if (start_s_inout) {
        *start_s_inout = start_s;
    }
    if (end_s_inout) {
        *end_s_inout = end_s;
    }
    reader.timeRange = CMTimeRangeMake(CMTimeMakeWithSeconds(start_s, 600),
                                       CMTimeMakeWithSeconds(end_s - start_s, 600));

    AVAssetReaderTrackOutput *output = [AVAssetReaderTrackOutput
        assetReaderTrackOutputWithTrack:track
                         outputSettings:@{
                             (id)kCVPixelBufferPixelFormatTypeKey:
                                 @(kCVPixelFormatType_32BGRA)
                         }];
    output.alwaysCopiesSampleData = NO;
    if (![reader canAddOutput:output]) {
        tas_set_err(err_out, @"couldn't decode that movie's video");
        return nil;
    }
    [reader addOutput:output];

    if (out_size) {
        CGSize natural = CGSizeApplyAffineTransform(track.naturalSize, track.preferredTransform);
        *out_size = CGSizeMake(fabs(natural.width), fabs(natural.height));
    }
    if (out_output) {
        *out_output = output;
    }
    return reader;
}

// Decodes `[start_s, end_s)` at roughly `fps`, handing each frame to
// `on_frame` as BGRA. Returning false from the callback stops the decode
// early. Returns 0 on success, -1 on error.
int tas_video_decode(const char *path,
                     double start_s,
                     double end_s,
                     uint32_t fps,
                     void *ctx,
                     bool (*on_frame)(void *ctx,
                                      const uint8_t *bgra,
                                      uint32_t w,
                                      uint32_t h,
                                      uint32_t stride,
                                      double pts_s),
                     char **err_out) {
    if (err_out) {
        *err_out = NULL;
    }
    if (!on_frame) {
        tas_set_err(err_out, @"no frame callback was given");
        return -1;
    }
    @autoreleasepool {
        NSURL *url = [NSURL fileURLWithPath:[NSString stringWithUTF8String:path]];
        AVAssetReaderTrackOutput *output = nil;
        AVAssetReader *reader =
            tas_open_video_reader(url, &start_s, &end_s, &output, NULL, err_out);
        if (!reader) {
            return -1;
        }
        if (![reader startReading]) {
            tas_set_err(err_out, reader.error ? reader.error.localizedDescription
                                              : @"couldn't start decoding");
            return -1;
        }

        // Frames come out on an even 1/fps grid, and the most recent decoded
        // frame is held across gaps in the source.
        //
        // That last part matters more than it sounds: a screen recording is
        // never constant-rate, because ScreenCaptureKit only emits a frame
        // when something actually changes. A still region can go half a second
        // without producing one. Handing those gaps to the caller would make
        // every fps-based export -- a GIF above all -- come out short and
        // unevenly paced, so a still stretch yields repeated frames instead of
        // no frames.
        double interval = fps > 0 ? 1.0 / (double)fps : 0.0;
        double clamped_start = start_s > 0 ? start_s : 0.0;
        double next_slot = clamped_start;
        bool keep_going = true;

        // __block, or the block below captures the initial NULL by value and
        // silently never emits anything.
        __block CVPixelBufferRef held = NULL;
        // Emits `held` at `at_s`; returns what the callback said.
        bool (^emit)(double) = ^bool(double at_s) {
            if (!held) {
                return true;
            }
            CVPixelBufferLockBaseAddress(held, kCVPixelBufferLock_ReadOnly);
            const uint8_t *base = (const uint8_t *)CVPixelBufferGetBaseAddress(held);
            bool cont = true;
            if (base) {
                cont = on_frame(ctx, base, (uint32_t)CVPixelBufferGetWidth(held),
                                (uint32_t)CVPixelBufferGetHeight(held),
                                (uint32_t)CVPixelBufferGetBytesPerRow(held), at_s);
            }
            CVPixelBufferUnlockBaseAddress(held, kCVPixelBufferLock_ReadOnly);
            return cont;
        };

        CMSampleBufferRef sample = NULL;
        while (keep_going && (sample = [output copyNextSampleBuffer])) {
            CMTime pts = CMSampleBufferGetPresentationTimeStamp(sample);
            double pts_s = CMTIME_IS_NUMERIC(pts) ? CMTimeGetSeconds(pts) : 0.0;
            CVImageBufferRef image = CMSampleBufferGetImageBuffer(sample);

            if (image) {
                // Fill every slot this new frame has moved past, using the
                // frame that was on screen for them -- the previous one.
                if (interval > 0) {
                    while (keep_going && next_slot + 1e-9 < pts_s) {
                        keep_going = emit(next_slot);
                        next_slot += interval;
                    }
                }
                if (held) {
                    CVPixelBufferRelease(held);
                }
                held = CVPixelBufferRetain(image);
                if (interval <= 0) {
                    // No pacing asked for: hand over every source frame.
                    keep_going = emit(pts_s);
                }
            }
            CFRelease(sample);
            sample = NULL;
        }

        // And the tail: slots between the last source frame and the end of the
        // range, which a recording that ends on a still screen always has.
        if (keep_going && interval > 0 && held) {
            double stop = end_s > clamped_start ? end_s : clamped_start;
            while (keep_going && next_slot + 1e-9 < stop) {
                keep_going = emit(next_slot);
                next_slot += interval;
            }
        }
        if (held) {
            CVPixelBufferRelease(held);
        }

        // A caller-requested stop is not a failure; only the reader saying so is.
        if (keep_going && reader.status == AVAssetReaderStatusFailed) {
            tas_set_err(err_out, reader.error ? reader.error.localizedDescription
                                              : @"decoding failed part-way through");
            return -1;
        }
        [reader cancelReading];
        return 0;
    }
}

// Builds the trimmed, speed-scaled audio for a transcode, as a reader over an
// AVMutableComposition. `speed` > 1 shortens it. Returns nil when there is no
// audio to carry over, which is not an error.
static AVAssetReader *tas_build_audio_reader(AVURLAsset *asset,
                                             double start_s,
                                             double end_s,
                                             double speed,
                                             AVAssetReaderAudioMixOutput **out_output) {
    NSArray<AVAssetTrack *> *audioTracks = [asset tracksWithMediaType:AVMediaTypeAudio];
    if (audioTracks.count == 0) {
        return nil;
    }

    AVMutableComposition *composition = [AVMutableComposition composition];
    CMTimeRange range = CMTimeRangeMake(CMTimeMakeWithSeconds(start_s, 600),
                                        CMTimeMakeWithSeconds(end_s - start_s, 600));
    NSMutableArray<AVAssetTrack *> *composed = [NSMutableArray array];
    for (AVAssetTrack *track in audioTracks) {
        AVMutableCompositionTrack *dest =
            [composition addMutableTrackWithMediaType:AVMediaTypeAudio
                                     preferredTrackID:kCMPersistentTrackID_Invalid];
        NSError *error = nil;
        if (![dest insertTimeRange:range ofTrack:track atTime:kCMTimeZero error:&error]) {
            continue;
        }
        [composed addObject:dest];
    }
    if (composed.count == 0) {
        return nil;
    }

    // Time-stretch rather than resample: scaleTimeRange pitch-corrects through
    // the audio mix's algorithm, so 2x playback still sounds like speech and
    // not like a chipmunk.
    if (speed > 0 && fabs(speed - 1.0) > 1e-6) {
        CMTimeRange whole = CMTimeRangeMake(kCMTimeZero, composition.duration);
        [composition scaleTimeRange:whole
                         toDuration:CMTimeMultiplyByFloat64(composition.duration, 1.0 / speed)];
    }

    NSError *error = nil;
    AVAssetReader *reader = [[AVAssetReader alloc] initWithAsset:composition error:&error];
    if (!reader) {
        return nil;
    }

    AVMutableAudioMix *mix = [AVMutableAudioMix audioMix];
    NSMutableArray<AVAudioMixInputParameters *> *params = [NSMutableArray array];
    for (AVAssetTrack *track in composed) {
        AVMutableAudioMixInputParameters *p =
            [AVMutableAudioMixInputParameters audioMixInputParametersWithTrack:track];
        p.audioTimePitchAlgorithm = AVAudioTimePitchAlgorithmSpectral;
        [params addObject:p];
    }
    mix.inputParameters = params;

    // Mixed down to one stereo track: the output is a single AAC track, and
    // this is where two recorded sources (system + mic) become one.
    AVAssetReaderAudioMixOutput *output = [AVAssetReaderAudioMixOutput
        assetReaderAudioMixOutputWithAudioTracks:composed
                                   audioSettings:@{
                                       AVFormatIDKey: @(kAudioFormatLinearPCM),
                                       AVLinearPCMBitDepthKey: @16,
                                       AVLinearPCMIsFloatKey: @NO,
                                       AVLinearPCMIsBigEndianKey: @NO,
                                       AVLinearPCMIsNonInterleaved: @NO,
                                       AVSampleRateKey: @48000,
                                       AVNumberOfChannelsKey: @2,
                                   }];
    output.audioMix = mix;
    if (![reader canAddOutput:output]) {
        return nil;
    }
    [reader addOutput:output];
    if (out_output) {
        *out_output = output;
    }
    return reader;
}

// Re-encodes `[start_s, end_s)` of `src` into `dst`.
//
// Every decoded frame goes to `process`, which fills `bgra_out` (always
// out_w x out_h, tightly packed) and may rewrite the PTS, or return false to
// drop the frame -- that is how crop, resize, speed, compositing and censoring
// reach the output without any of them living here. Returns 0, or -1 on error.
int tas_video_transcode(const char *src,
                        const char *dst,
                        double start_s,
                        double end_s,
                        double speed,
                        uint32_t out_w,
                        uint32_t out_h,
                        bool keep_audio,
                        void *ctx,
                        bool (*process)(void *ctx,
                                        const uint8_t *bgra_in,
                                        uint32_t in_w,
                                        uint32_t in_h,
                                        uint32_t in_stride,
                                        uint8_t *bgra_out,
                                        double *pts_s_inout),
                        char **err_out) {
    if (err_out) {
        *err_out = NULL;
    }
    if (!process) {
        tas_set_err(err_out, @"no frame callback was given");
        return -1;
    }
    if (out_w < 2 || out_h < 2) {
        tas_set_err(err_out, @"the output size is too small");
        return -1;
    }
    @autoreleasepool {
        NSURL *srcURL = [NSURL fileURLWithPath:[NSString stringWithUTF8String:src]];
        NSURL *dstURL = [NSURL fileURLWithPath:[NSString stringWithUTF8String:dst]];
        [[NSFileManager defaultManager] removeItemAtURL:dstURL error:nil];

        AVAssetReaderTrackOutput *videoOut = nil;
        double clamped_start = start_s;
        double clamped_end = end_s;
        AVAssetReader *videoReader = tas_open_video_reader(srcURL, &clamped_start, &clamped_end,
                                                           &videoOut, NULL, err_out);
        if (!videoReader) {
            return -1;
        }

        AVURLAsset *asset = [AVURLAsset URLAssetWithURL:srcURL options:nil];

        AVAssetReaderAudioMixOutput *audioOut = nil;
        AVAssetReader *audioReader =
            keep_audio ? tas_build_audio_reader(asset, clamped_start, clamped_end, speed, &audioOut)
                       : nil;

        NSError *error = nil;
        AVAssetWriter *writer = [[AVAssetWriter alloc] initWithURL:dstURL
                                                          fileType:AVFileTypeMPEG4
                                                             error:&error];
        if (!writer) {
            tas_set_err(err_out, error ? error.localizedDescription : @"couldn't create the export");
            return -1;
        }

        size_t even_w = tas_even(out_w);
        size_t even_h = tas_even(out_h);
        AVAssetWriterInput *videoIn = [AVAssetWriterInput
            assetWriterInputWithMediaType:AVMediaTypeVideo
                           outputSettings:@{
                               AVVideoCodecKey: AVVideoCodecTypeH264,
                               AVVideoWidthKey: @(even_w),
                               AVVideoHeightKey: @(even_h),
                           }];
        videoIn.expectsMediaDataInRealTime = NO;
        AVAssetWriterInputPixelBufferAdaptor *adaptor = [AVAssetWriterInputPixelBufferAdaptor
            assetWriterInputPixelBufferAdaptorWithAssetWriterInput:videoIn
                                       sourcePixelBufferAttributes:@{
                                           (id)kCVPixelBufferPixelFormatTypeKey:
                                               @(kCVPixelFormatType_32BGRA),
                                           (id)kCVPixelBufferWidthKey: @(even_w),
                                           (id)kCVPixelBufferHeightKey: @(even_h),
                                       }];
        if (![writer canAddInput:videoIn]) {
            tas_set_err(err_out, @"couldn't set up the export's video");
            return -1;
        }
        [writer addInput:videoIn];

        AVAssetWriterInput *audioIn = nil;
        if (audioReader) {
            AudioChannelLayout layout = {0};
            layout.mChannelLayoutTag = kAudioChannelLayoutTag_Stereo;
            audioIn = [AVAssetWriterInput
                assetWriterInputWithMediaType:AVMediaTypeAudio
                               outputSettings:@{
                                   AVFormatIDKey: @(kAudioFormatMPEG4AAC),
                                   AVSampleRateKey: @48000,
                                   AVNumberOfChannelsKey: @2,
                                   AVEncoderBitRateKey: @128000,
                                   AVChannelLayoutKey: [NSData dataWithBytes:&layout
                                                                      length:sizeof(layout)],
                               }];
            audioIn.expectsMediaDataInRealTime = NO;
            if ([writer canAddInput:audioIn]) {
                [writer addInput:audioIn];
            } else {
                audioIn = nil;
                audioReader = nil;
            }
        }

        if (![writer startWriting]) {
            tas_set_err(err_out, writer.error ? writer.error.localizedDescription
                                              : @"couldn't start the export");
            return -1;
        }
        [writer startSessionAtSourceTime:kCMTimeZero];
        if (![videoReader startReading]) {
            tas_set_err(err_out, videoReader.error ? videoReader.error.localizedDescription
                                                   : @"couldn't start decoding");
            [writer cancelWriting];
            return -1;
        }
        if (audioReader && ![audioReader startReading]) {
            audioReader = nil;
            audioIn = nil;
        }

        // One reusable destination buffer: the callback writes a full
        // out_w x out_h BGRA frame into it every time.
        size_t out_stride = even_w * 4;
        uint8_t *scratch = calloc(out_stride * even_h, 1);
        if (!scratch) {
            tas_set_err(err_out, @"couldn't allocate the export buffer");
            [writer cancelWriting];
            return -1;
        }

        __block bool failed = false;
        __block NSString *failure = nil;

        dispatch_semaphore_t done = dispatch_semaphore_create(0);
        dispatch_queue_t videoQueue =
            dispatch_queue_create("dev.tuanp.slickshot.transcode.video", DISPATCH_QUEUE_SERIAL);

        [videoIn requestMediaDataWhenReadyOnQueue:videoQueue usingBlock:^{
            while (videoIn.isReadyForMoreMediaData) {
                CMSampleBufferRef sample = [videoOut copyNextSampleBuffer];
                if (!sample) {
                    [videoIn markAsFinished];
                    dispatch_semaphore_signal(done);
                    return;
                }
                @autoreleasepool {
                    CMTime pts = CMSampleBufferGetPresentationTimeStamp(sample);
                    double pts_s = CMTIME_IS_NUMERIC(pts) ? CMTimeGetSeconds(pts) : 0.0;
                    // Output time is measured from the trim's start, so an
                    // export beginning at 4s starts at zero, not at four.
                    double out_pts = pts_s - clamped_start;
                    if (out_pts < 0) {
                        out_pts = 0;
                    }

                    CVImageBufferRef image = CMSampleBufferGetImageBuffer(sample);
                    bool keep = false;
                    if (image) {
                        CVPixelBufferLockBaseAddress(image, kCVPixelBufferLock_ReadOnly);
                        const uint8_t *base =
                            (const uint8_t *)CVPixelBufferGetBaseAddress(image);
                        if (base) {
                            keep = process(ctx, base, (uint32_t)CVPixelBufferGetWidth(image),
                                           (uint32_t)CVPixelBufferGetHeight(image),
                                           (uint32_t)CVPixelBufferGetBytesPerRow(image), scratch,
                                           &out_pts);
                        }
                        CVPixelBufferUnlockBaseAddress(image, kCVPixelBufferLock_ReadOnly);
                    }

                    if (keep) {
                        CVPixelBufferRef out = NULL;
                        CVReturn rc = CVPixelBufferPoolCreatePixelBuffer(
                            kCFAllocatorDefault, adaptor.pixelBufferPool, &out);
                        if (rc == kCVReturnSuccess && out) {
                            CVPixelBufferLockBaseAddress(out, 0);
                            uint8_t *dstBase = (uint8_t *)CVPixelBufferGetBaseAddress(out);
                            size_t dstStride = CVPixelBufferGetBytesPerRow(out);
                            for (size_t y = 0; y < even_h; y++) {
                                memcpy(dstBase + y * dstStride, scratch + y * out_stride,
                                       out_stride);
                            }
                            CVPixelBufferUnlockBaseAddress(out, 0);
                            if (![adaptor appendPixelBuffer:out
                                       withPresentationTime:CMTimeMakeWithSeconds(out_pts, 600)]) {
                                failed = true;
                                failure = @"the export's encoder rejected a frame";
                            }
                            CVPixelBufferRelease(out);
                        }
                    }
                }
                CFRelease(sample);

                if (failed) {
                    [videoIn markAsFinished];
                    dispatch_semaphore_signal(done);
                    return;
                }
            }
        }];

        dispatch_semaphore_t audioDone = dispatch_semaphore_create(0);
        if (audioReader && audioIn) {
            dispatch_queue_t audioQueue =
                dispatch_queue_create("dev.tuanp.slickshot.transcode.audio", DISPATCH_QUEUE_SERIAL);
            [audioIn requestMediaDataWhenReadyOnQueue:audioQueue usingBlock:^{
                while (audioIn.isReadyForMoreMediaData) {
                    CMSampleBufferRef sample = [audioOut copyNextSampleBuffer];
                    if (!sample) {
                        [audioIn markAsFinished];
                        dispatch_semaphore_signal(audioDone);
                        return;
                    }
                    [audioIn appendSampleBuffer:sample];
                    CFRelease(sample);
                }
            }];
        } else {
            dispatch_semaphore_signal(audioDone);
        }

        dispatch_semaphore_wait(done, DISPATCH_TIME_FOREVER);
        dispatch_semaphore_wait(audioDone, DISPATCH_TIME_FOREVER);
        free(scratch);

        if (failed) {
            [writer cancelWriting];
            tas_set_err(err_out, failure ?: @"the export failed");
            return -1;
        }

        __block bool finished = false;
        dispatch_semaphore_t writerDone = dispatch_semaphore_create(0);
        [writer finishWritingWithCompletionHandler:^{
            finished = writer.status == AVAssetWriterStatusCompleted;
            dispatch_semaphore_signal(writerDone);
        }];
        dispatch_semaphore_wait(writerDone, DISPATCH_TIME_FOREVER);

        if (!finished) {
            tas_set_err(err_out, writer.error ? writer.error.localizedDescription
                                              : @"the export didn't finish");
            return -1;
        }
        return 0;
    }
}
