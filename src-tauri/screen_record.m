// Native macOS screen recording via ScreenCaptureKit + AVFoundation, exposed
// to Rust through a tiny C ABI -- the same split as vision_ocr.m: this file
// owns every Objective-C object, and the Rust side (src/record/macos.rs) only
// ever holds an opaque pointer.
//
// ScreenCaptureKit feeds an AVAssetWriter directly, so H.264 encoding is
// hardware-accelerated and the region crop happens before a single frame
// reaches us. System audio rides the same SCStream (macOS 13+); the
// microphone is a separate AVCaptureSession, resampled onto the stream's
// clock because the two devices free-run independently.
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
// Most recent screen-sample host time, used to measure how far the mic's own
// clock has drifted from the stream's.
@property(nonatomic, assign) double lastVideoHostSeconds;
@property(nonatomic, assign) double micOffsetSeconds;
@property(nonatomic, assign) BOOL micOffsetPrimed;

@end

@implementation TasRecorder

- (instancetype)init {
    self = [super init];
    if (self) {
        _sampleQueue = dispatch_queue_create("dev.tuanp.slickshot.record", DISPATCH_QUEUE_SERIAL);
        _firstPTS = kCMTimeInvalid;
        _sessionStarted = NO;
        _flags = 0;
        _micOffsetPrimed = NO;
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
        self.lastVideoHostSeconds = CMTimeGetSeconds(pts);
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

// Microphone samples come from AVCaptureSession, whose clock is not the
// stream's. Rather than trusting either, the offset between them is measured
// once and then smoothed, and each buffer is retimed by it -- so a long
// recording ends with the two tracks still lined up instead of tens of
// milliseconds apart.
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
    double micSeconds = CMTimeGetSeconds(pts);
    double videoSeconds = self.lastVideoHostSeconds;
    if (videoSeconds <= 0) {
        return;
    }

    double instantaneous = videoSeconds - micSeconds;
    if (!self.micOffsetPrimed) {
        self.micOffsetSeconds = instantaneous;
        self.micOffsetPrimed = YES;
    } else {
        // Heavily smoothed: a per-buffer correction would chase jitter and
        // audibly warble. This tracks drift, not latency.
        self.micOffsetSeconds = self.micOffsetSeconds * 0.999 + instantaneous * 0.001;
    }

    CMTime adjusted = CMTimeAdd(pts, CMTimeMakeWithSeconds(self.micOffsetSeconds, pts.timescale));
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
