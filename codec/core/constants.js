/**
 * ATRAC3plus scalar geometry and container constants.
 */

/** PCM samples coded per channel in one ATRAC3plus frame. */
export const FRAME_SAMPLES = 2048
/** PCM samples in one QMF subband block. */
export const SUBBAND_SAMPLES = 128
/** QMF subband blocks per frame. */
export const SUBBAND_BLOCKS = 16
/** Largest maintained stream channel count. */
export const MAX_CHANNELS = 8
/** Largest channel count in one mono/stereo coding unit. */
export const CODING_UNIT_MAX_CHANNELS = 2
/** Largest number of serialized coding units in one frame. */
export const MAX_CODING_UNITS = 5
/** Number of spectral quantization units per channel. */
export const QUANTIZATION_UNIT_COUNT = 32
/** Quantization units represented by word-length side-data predictors. */
export const WORD_LENGTH_SIDE_DATA_BANDS = 10
/** Bits used by each channel's word-length packing-mode selector. */
export const WORD_LENGTH_MODE_BITS = 2

/** Fixed code-table sidechain field widths. */
export const CODE_TABLE_COUNT_FLAG_BITS = 1
/** Code-table explicit count bits. */
export const CODE_TABLE_EXPLICIT_COUNT_BITS = 5
/** Code-table gain mode bits. */
export const CODE_TABLE_GAIN_MODE_BITS = 1
/** Code-table context bits. */
export const CODE_TABLE_CONTEXT_BITS = 1
/** Code-table mode bits. */
export const CODE_TABLE_MODE_BITS = 2

/** Shared scale-factor representation geometry. */
export const SCALE_FACTOR_MODE_BITS = 2
/** Scale-factor range max width. */
export const SCALE_FACTOR_RANGE_MAX_WIDTH = 5
/** Number of encoder analysis subbands. */
export const ANALYSIS_BANDS = 16
/** Persistent analysis slots per subband. */
export const ANALYSIS_SLOTS = 9
/** QMF analysis look-back samples retained per channel. */
export const ANALYSIS_TAIL_SAMPLES = 384
/** Sample-domain container alignment delay. */
export const DELAY_SAMPLES = 184
/** Analyzed-frame shifts before new QMF output reaches the first MDCT window. */
export const ANALYSIS_TO_STREAM_DELAY_FRAMES = 7
/** Maximum silent frame tail required to flush a nonempty final submission. */
export const FULL_FRAME_FLUSH_TAIL_FRAMES = 9
/** Fixed exact-allocation retry grid and bounded attempt count. */
export const BUDGET_RETRY_STEP_BITS = 32
/** Budget retry limit. */
export const BUDGET_RETRY_LIMIT = 16
/** Sentinel cost assigned to a spectrum choice that cannot be encoded. */
export const SPECTRUM_FORBIDDEN_BITS = 0x4000

/** Fixed gain-point syntax geometry. */
export const GAIN_SLOT_COUNT = 7
/** Gain level default. */
export const GAIN_LEVEL_DEFAULT = 7
/** Gain level max. */
export const GAIN_LEVEL_MAX = 15
/** Gain location max. */
export const GAIN_LOCATION_MAX = 31
/** Fixed forward/inverse gain reconstruction geometry. */
export const GAIN_SCALE_STEP_COUNT = 64
/** Gain scale sample count. */
export const GAIN_SCALE_SAMPLE_COUNT = 256
/** Four-sample detector blocks measured in one gain-analysis window. */
export const GAIN_WINDOW_BLOCKS = 32
/** PCM values measured by each gain-analysis detector block. */
export const GAIN_WINDOW_FLOATS_PER_BLOCK = 4

/** Fixed ATRAC3plus MDCT kernel geometry. */
export const MDCT_TIME_SAMPLE_COUNT = 256
/** MDCT coefficient count. */
export const MDCT_COEFFICIENT_COUNT = 128

/** Bits in the frame start flag. */
export const FRAME_HEADER_BITS = 1
/** Bits in a coding-unit frame tag. */
export const FRAME_TAG_BITS = 2
/** Bias applied to the encoded extension payload length. */
export const EXTENSION_LENGTH_OFFSET_BITS = 7
/** Bits in an encoded extension payload length. */
export const EXTENSION_LENGTH_BITS = 11
/** Total fixed extension header width. */
export const EXTENSION_HEADER_BITS = 18
/** Largest encodable extension payload length. */
export const EXTENSION_LENGTH_LIMIT = (1 << EXTENSION_LENGTH_BITS) - 1
/** Byte used to fill unused frame payload. */
export const FRAME_PADDING_BYTE = 1
/** Largest valid ATRAC3plus frame cursor (8 KiB minus one bit position). */
export const MAX_FRAME_BIT_POSITION = 0xffff
/** Maximum frame storage addressable by the 16-bit ATRAC3plus bit cursor. */
export const MAX_FRAME_BYTES = 0x2000
/** Zero padding for the reader's three-byte peek window. */
export const BITSTREAM_PADDING_BYTES = 3
/** Extra pack storage used to detect a coding unit crossing frame capacity. */
export const FRAME_PACK_SCRATCH_SLACK_BYTES = 2048

/** WAVE_FORMAT_EXTENSIBLE. */
export const WAVE_FORMAT_TAG = 0xfffe
/** ATRACX extension version emitted by reference. */
export const WAVE_FORMAT_VERSION = 1
/** ATRACX subtype GUID in canonical textual form. */
export const WAVE_SUBTYPE_GUID = 'e923aabf-cb58-4471-a119-fffa01e4ce62'

/** Maintained sample-rate index used by the packed codec configuration. */
export const SAMPLE_RATE_INDEX = Object.freeze({
  32000: 0,
  44100: 1,
  48000: 2,
})

/** Stream topology selector used by the packed codec configuration. */
export const STREAM_CHANNEL_MODE = Object.freeze({
  1: 1,
  2: 2,
  6: 5,
  8: 7,
})

/** Canonical WAVE speaker mask for each maintained channel topology. */
export const CHANNEL_MASK = Object.freeze({
  1: 0x4,
  2: 0x3,
  6: 0x3f,
  8: 0x63f,
})

/** Centralized codec and implementation constants. */

/** Allocation band order capacity. */
export const ALLOCATION_BAND_ORDER_CAPACITY =
  CODING_UNIT_MAX_CHANNELS * QUANTIZATION_UNIT_COUNT

/** Allocation base bits. */
export const ALLOCATION_BASE_BITS = 4

/** Analysis gain adjustment gain max channels. */
export const ANALYSIS_GAIN_ADJUSTMENT_GAIN_MAX_CHANNELS = 2

/** Analysis gain adjustment gain window samples. */
export const ANALYSIS_GAIN_ADJUSTMENT_GAIN_WINDOW_SAMPLES = 256

/** Analysis gain detection current. */
export const ANALYSIS_GAIN_DETECTION_CURRENT = 1

/** Analysis gain detection gain bands. */
export const ANALYSIS_GAIN_DETECTION_GAIN_BANDS = 16

/** Analysis gain detection gain max channels. */
export const ANALYSIS_GAIN_DETECTION_GAIN_MAX_CHANNELS = 2

/** Analysis gain detection gain prefix samples. */
export const ANALYSIS_GAIN_DETECTION_GAIN_PREFIX_SAMPLES = 12

/** Analysis gain detection group entries. */
export const ANALYSIS_GAIN_DETECTION_GROUP_ENTRIES = 64

/** Analysis gain detection next. */
export const ANALYSIS_GAIN_DETECTION_NEXT = 2

/** Analysis gain detection no entry. */
export const ANALYSIS_GAIN_DETECTION_NO_ENTRY = -1

/** Analysis gain detection previous. */
export const ANALYSIS_GAIN_DETECTION_PREVIOUS = 0

/** Analysis gain overflow normalize tail level. */
export const ANALYSIS_GAIN_OVERFLOW_NORMALIZE_TAIL_LEVEL = 6

/** Analysis gain record policy normalize tail level. */
export const ANALYSIS_GAIN_RECORD_POLICY_NORMALIZE_TAIL_LEVEL = 6

/** Analysis intensity band count. */
export const ANALYSIS_INTENSITY_BAND_COUNT = 16

/** Analysis intensity samples. */
export const ANALYSIS_INTENSITY_SAMPLES = 128

/** Analysis tone analysis bands. */
export const ANALYSIS_TONE_ANALYSIS_BANDS = 16

/** Analysis tone analysis frame samples. */
export const ANALYSIS_TONE_ANALYSIS_FRAME_SAMPLES = 256

/** Analysis tone analysis subband samples. */
export const ANALYSIS_TONE_ANALYSIS_SUBBAND_SAMPLES = 128

/** Analysis tone detection bands. */
export const ANALYSIS_TONE_DETECTION_BANDS = 16

/** Analysis tone detection frame samples. */
export const ANALYSIS_TONE_DETECTION_FRAME_SAMPLES = 256

/** Anti phase ratio. */
export const ANTI_PHASE_RATIO = Math.fround(1 - 1 / 32768)

/** Arena generations. */
export const ARENA_GENERATIONS = 3

/** Band stride. */
export const BAND_STRIDE = ANALYSIS_SLOTS * SUBBAND_SAMPLES

/** Band0 max no edit change energy per bit. */
export const BAND0_MAX_NO_EDIT_CHANGE_ENERGY_PER_BIT = 0.01

/** Band0 source tail level. */
export const BAND0_SOURCE_TAIL_LEVEL = 6

/** Boundary end. */
export const BOUNDARY_END = 1

/** Boundary start. */
export const BOUNDARY_START = 0

/** Channel header bits. */
export const CHANNEL_HEADER_BITS =
  CODE_TABLE_CONTEXT_BITS + CODE_TABLE_MODE_BITS

/** Channels. */
export const CHANNELS = 2

/** Code-table forbidden bits. */
export const CODE_TABLE_FORBIDDEN_BITS = 0x4000

/** Code-table mode diff. */
export const CODE_TABLE_MODE_DIFF = 2

/** Code-table mode direct. */
export const CODE_TABLE_MODE_DIRECT = 1

/** Code-table mode fixed. */
export const CODE_TABLE_MODE_FIXED = 0

/** Code-table mode pair. */
export const CODE_TABLE_MODE_PAIR = 3

/** Code-table mode stride. */
export const CODE_TABLE_MODE_STRIDE = 4

/** Code-table type one bit. */
export const CODE_TABLE_TYPE_ONE_BIT = 2

/** Code-table type value. */
export const CODE_TABLE_TYPE_VALUE = 1

/** Spectrum pricing band count. */
export const SPECTRUM_PRICING_BAND_COUNT = 32

/** Spectrum pricing cache slots. */
export const SPECTRUM_PRICING_CACHE_SLOTS = 2

/** Spectrum pricing candidate count. */
export const SPECTRUM_PRICING_CANDIDATE_COUNT = 8

/** Spectrum pricing context count. */
export const SPECTRUM_PRICING_CONTEXT_COUNT = 2

/** Spectrum pricing empty key. */
export const SPECTRUM_PRICING_EMPTY_KEY = 0xff

/** Active spectrum pricing mode count. */
export const SPECTRUM_PRICING_MODE_COUNT = 7

/** Maximum spectrum pricing band work length. */
export const SPECTRUM_PRICING_MAX_BAND_LENGTH = 128

/** Core mode min inclusive threshold. */
export const CORE_MODE_MIN_INCLUSIVE_THRESHOLD = 0xdac

/** Correlation cap. */
export const CORRELATION_CAP = 60

/** Correlation log fallback. */
export const CORRELATION_LOG_FALLBACK = -160

/** Count mask. */
export const COUNT_MASK = 7

/** Current tone slot. */
export const CURRENT_TONE_SLOT = 4

/** Curve bits. */
export const CURVE_BITS = 2

/** Curve header bits. */
export const CURVE_HEADER_BITS = 10

/** Decrease energy ratio. */
export const DECREASE_ENERGY_RATIO = Math.fround(0.6299605)

/** Default PCM channels. */
export const DEFAULT_PCM_CHANNELS = 2

/** Default PCM sample rate. */
export const DEFAULT_PCM_SAMPLE_RATE = 44100

/** Delta header bits. */
export const DELTA_HEADER_BITS = 5

/** DFT bins. */
export const DFT_BINS = 129

/** Direction lower. */
export const DIRECTION_LOWER = 0

/** Direction raise. */
export const DIRECTION_RAISE = 1

/** Disabled level. */
export const DISABLED_LEVEL = 15

/** Done. */
export const DONE = 2

/** Draining. */
export const DRAINING = 1

/** Entry stride. */
export const ENTRY_STRIDE = 0x30

/** Expand after. */
export const EXPAND_AFTER = 2

/** Expand before. */
export const EXPAND_BEFORE = 1

/** Feeding. */
export const FEEDING = 0

/** Five band average scale. */
export const FIVE_BAND_AVERAGE_SCALE = 0.20000000298023224

/** Float rounding bias. */
export const FLOAT_ROUNDING_BIAS = Math.fround(12582912)

/** Frequency base bits. */
export const FREQUENCY_BASE_BITS = 10

/** Gain band count. */
export const GAIN_BAND_COUNT = 16

/** Gain control initial bits log2 e. */
export const GAIN_CONTROL_INITIAL_BITS_LOG2_E = 1.442695021629333

/** Gain control log2 e. */
export const GAIN_CONTROL_LOG2_E = Math.fround(Math.LOG2E)

/** Gain event samples per block. */
export const GAIN_EVENT_SAMPLES_PER_BLOCK = 4

/** Gain floats per block. */
export const GAIN_FLOATS_PER_BLOCK = 4

/** Gain history samples. */
export const GAIN_HISTORY_SAMPLES = 64

/** Gain minimum. */
export const GAIN_MINIMUM = -6

/** Gain mode forbidden bits. */
export const GAIN_MODE_FORBIDDEN_BITS = 0x4000

/** Gain overflow state capacity. */
export const GAIN_OVERFLOW_STATE_CAPACITY = 32768

/** Gain point count maximum. */
export const GAIN_POINT_COUNT_MAXIMUM = 7

/** Gain point group entries. */
export const GAIN_POINT_GROUP_ENTRIES = 64

/** Gain point groups. */
export const GAIN_POINT_GROUPS = 2

/** Gain records. */
export const GAIN_RECORDS = ANALYSIS_BANDS

/** Gain samples per step. */
export const GAIN_SAMPLES_PER_STEP = 4

/** Gain scale samples. */
export const GAIN_SCALE_SAMPLES = GAIN_SCALE_SAMPLE_COUNT

/** Gain step count. */
export const GAIN_STEP_COUNT = GAIN_SCALE_STEP_COUNT

/** Group count. */
export const GROUP_COUNT = 8

/** Header amplitude mode. */
export const HEADER_AMPLITUDE_MODE = 1

/** Header band count. */
export const HEADER_BAND_COUNT = 2

/** Header enable. */
export const HEADER_ENABLE = 0

/** Header frequency. */
export const HEADER_FREQUENCY = 0xd8

/** Header joint. */
export const HEADER_JOINT = 0xc6

/** In phase ratio. */
export const IN_PHASE_RATIO = Math.fround(1 / 32768)

/** Increase energy ratio. */
export const INCREASE_ENERGY_RATIO = Math.fround(1.587401)

/** Independent amplitude mode. */
export const INDEPENDENT_AMPLITUDE_MODE = 1

/** Initial level. */
export const INITIAL_LEVEL = 6

/** Intensity history slots. */
export const INTENSITY_HISTORY_SLOTS = 5

/** I/O scale-factor decoder group first bias. */
export const IO_SCALE_FACTOR_DECODER_GROUP_FIRST_BIAS = 8

/** I/O scale-factor decoder group mask. */
export const IO_SCALE_FACTOR_DECODER_GROUP_MASK = 0x0f

/** I/O scale-factor decoder mask. */
export const IO_SCALE_FACTOR_DECODER_MASK = 0x3f

/** I/O scale-factor decoder shape bias. */
export const IO_SCALE_FACTOR_DECODER_SHAPE_BIAS = 7

/** I/O scale-factor decoder shape codebook stride. */
export const IO_SCALE_FACTOR_DECODER_SHAPE_CODEBOOK_STRIDE = 9

/** I/O scale-factor syntax codebook header bits. */
export const IO_SCALE_FACTOR_SYNTAX_CODEBOOK_HEADER_BITS = 2

/** I/O scale-factor syntax group first bias. */
export const IO_SCALE_FACTOR_SYNTAX_GROUP_FIRST_BIAS = 8

/** I/O scale-factor syntax group mask. */
export const IO_SCALE_FACTOR_SYNTAX_GROUP_MASK = 0x0f

/** I/O scale-factor syntax scale-factor raw bits. */
export const IO_SCALE_FACTOR_SYNTAX_SCALE_FACTOR_RAW_BITS = 6

/** I/O scale-factor syntax shape bias. */
export const IO_SCALE_FACTOR_SYNTAX_SHAPE_BIAS = 7

/** I/O scale-factor syntax shape codebook stride. */
export const IO_SCALE_FACTOR_SYNTAX_SHAPE_CODEBOOK_STRIDE = 9

/** I/O tone syntax scale-factor raw bits. */
export const IO_TONE_SYNTAX_SCALE_FACTOR_RAW_BITS = 6

/** I/O word-length decoder mask. */
export const IO_WORD_LENGTH_DECODER_MASK = 7

/** I/O word-length decoder shape base stride. */
export const IO_WORD_LENGTH_DECODER_SHAPE_BASE_STRIDE = 144

/** I/O word-length decoder shape shift stride. */
export const IO_WORD_LENGTH_DECODER_SHAPE_SHIFT_STRIDE = 9

/** I/O word-length syntax codebook header bits. */
export const IO_WORD_LENGTH_SYNTAX_CODEBOOK_HEADER_BITS = 2

/** I/O word-length syntax shape base stride. */
export const IO_WORD_LENGTH_SYNTAX_SHAPE_BASE_STRIDE = 144

/** I/O word-length syntax shape shift stride. */
export const IO_WORD_LENGTH_SYNTAX_SHAPE_SHIFT_STRIDE = 9

/** Joint mix scale. */
export const JOINT_MIX_SCALE = Math.fround(0.5)

/** Level mask. */
export const LEVEL_MASK = 15

/** LFE budget bits. */
export const LFE_BUDGET_BITS = 0x88

/** Location mask. */
export const LOCATION_MASK = 31

/** Max cross mix. */
export const MAX_CROSS_MIX = 0.125

/** Max entries. */
export const MAX_ENTRIES = 16

/** Max iteration. */
export const MAX_ITERATION = 7

/** MDCT coefficients. */
export const MDCT_COEFFICIENTS = MDCT_COEFFICIENT_COUNT

/** MDCT scale. */
export const MDCT_SCALE = 0.015625

/** MDCT time samples. */
export const MDCT_TIME_SAMPLES = MDCT_TIME_SAMPLE_COUNT

/** Mix curve scale. */
export const MIX_CURVE_SCALE = Math.fround(0.3640598)

/** Mix curve steepness. */
export const MIX_CURVE_STEEPNESS = 10

/** Mix slot. */
export const MIX_SLOT = 7

/** Mode diff. */
export const MODE_DIFF = 2

/** Mode direct. */
export const MODE_DIRECT = 1

/** Mode fixed. */
export const MODE_FIXED = 0

/** Mode pair. */
export const MODE_PAIR = 3

/** Mode 1 raw header bits. */
export const MODE1_RAW_HEADER_BITS = 16

/** Mode 1 shape header bits. */
export const MODE1_SHAPE_HEADER_BITS = 25

/** Mode 3 raw header bits. */
export const MODE3_RAW_HEADER_BITS = 10

/** Mode 3 shape header bits excluding first delta. */
export const MODE3_SHAPE_HEADER_BITS_EXCLUDING_FIRST_DELTA = 16

/** Narrow overshoot. */
export const NARROW_OVERSHOOT = Math.fround(1.122462)

/** Narrow undershoot. */
export const NARROW_UNDERSHOOT = Math.fround(0.70710677)

/** Natural log to decibels. */
export const NATURAL_LOG_TO_DECIBELS = Math.fround(8.685889)

/** Newest analysis slot. */
export const NEWEST_ANALYSIS_SLOT = ANALYSIS_SLOTS - 1

/** Newest slot. */
export const NEWEST_SLOT = 8

/** Noise index mask. */
export const NOISE_INDEX_MASK = 0x03ff

/** Normalization clamp high. */
export const NORMALIZATION_CLAMP_HIGH = Math.fround(1.1220093)

/** Normalization clamp low. */
export const NORMALIZATION_CLAMP_LOW = Math.fround(-1.1220093)

/** Offset count. */
export const OFFSET_COUNT = 16

/** Offset scale. */
export const OFFSET_SCALE = 128

/** Overflow absolute limit. */
export const OVERFLOW_ABSOLUTE_LIMIT = 65536

/** Overflow relative factor. */
export const OVERFLOW_RELATIVE_FACTOR = 8

/** PCM WAVE bits per sample. */
export const PCM_WAVE_BITS_PER_SAMPLE = 16

/** PCM WAVE header bytes. */
export const PCM_WAVE_HEADER_BYTES = 44

/** Power slot. */
export const POWER_SLOT = 6

/** Previous tone slot. */
export const PREVIOUS_TONE_SLOT = 3

/** QMF analysis startup skip samples. */
export const QMF_ANALYSIS_STARTUP_SKIP_SAMPLES = 16

/** QMF startup skip samples. */
export const QMF_STARTUP_SKIP_SAMPLES = 16

/** QMF window samples. */
export const QMF_WINDOW_SAMPLES = ANALYSIS_TAIL_SAMPLES + FRAME_SAMPLES

/** Raw bits. */
export const RAW_BITS = 3

/** Record merge max final change energy ratio. */
export const RECORD_MERGE_MAX_FINAL_CHANGE_ENERGY_RATIO = 0.22

/** Record merge strict shape error. */
export const RECORD_MERGE_STRICT_SHAPE_ERROR = 0.2

/** Reduction level ceiling. */
export const REDUCTION_LEVEL_CEILING = 9

/** Reduction level floor. */
export const REDUCTION_LEVEL_FLOOR = -6

/** Row length. */
export const ROW_LENGTH = QUANTIZATION_UNIT_COUNT

/** Scale-factor delta base. */
export const SCALE_FACTOR_DELTA_BASE = 0x22

/** Scale-factor forbidden bits. */
export const SCALE_FACTOR_FORBIDDEN_BITS = 0x4000

/** Scale-factor mask. */
export const SCALE_FACTOR_MASK = 0x3f

/** Scale-factor target. */
export const SCALE_FACTOR_TARGET = Math.fround(0.89126587)

/** Scale history bands. */
export const SCALE_HISTORY_BANDS = 32

/** Second pass target factor. */
export const SECOND_PASS_TARGET_FACTOR = Math.fround(0.95)

/** Shape codebook count. */
export const SHAPE_CODEBOOK_COUNT = 64

/** Shape header bits. */
export const SHAPE_HEADER_BITS = 9

/** Sine samples. */
export const SINE_SAMPLES = 2048

/** Slot count. */
export const SLOT_COUNT = 5

/** Spectral noise seed mask. */
export const SPECTRAL_NOISE_SEED_MASK = 0x03fc

/** Spectral noise seed step. */
export const SPECTRAL_NOISE_SEED_STEP = 0x80

/** Spectrum code-table count. */
export const SPECTRUM_CODE_TABLE_COUNT = 8

/** Spectrum mode count. */
export const SPECTRUM_MODE_COUNT = 7

/** Spectrum table index. */
export const SPECTRUM_TABLE_INDEX = 1

/** State gain analysis current. */
export const STATE_GAIN_ANALYSIS_CURRENT = 1

/** State gain analysis gain bands. */
export const STATE_GAIN_ANALYSIS_GAIN_BANDS = 16

/** State gain analysis gain max channels. */
export const STATE_GAIN_ANALYSIS_GAIN_MAX_CHANNELS = 2

/** State gain analysis gain prefix samples. */
export const STATE_GAIN_ANALYSIS_GAIN_PREFIX_SAMPLES = 12

/** State gain analysis gain window samples. */
export const STATE_GAIN_ANALYSIS_GAIN_WINDOW_SAMPLES = 256

/** State gain analysis group entries. */
export const STATE_GAIN_ANALYSIS_GROUP_ENTRIES = 64

/** State gain analysis next. */
export const STATE_GAIN_ANALYSIS_NEXT = 2

/** State gain analysis no entry. */
export const STATE_GAIN_ANALYSIS_NO_ENTRY = -1

/** State gain analysis previous. */
export const STATE_GAIN_ANALYSIS_PREVIOUS = 0

/** Stereo merge max change energy per bit. */
export const STEREO_MERGE_MAX_CHANGE_ENERGY_PER_BIT = 1e-7

/** Subbands. */
export const SUBBANDS = 16

/** Tail mode none. */
export const TAIL_MODE_NONE = 0

/** Tail mode ones or bits. */
export const TAIL_MODE_ONES_OR_BITS = 2

/** Tail mode run. */
export const TAIL_MODE_RUN = 3

/** Tail none. */
export const TAIL_NONE = 0

/** Tail ones or bits. */
export const TAIL_ONES_OR_BITS = 2

/** Tail run. */
export const TAIL_RUN = 3

/** Tail zero. */
export const TAIL_ZERO = 1

/** Target deferred. */
export const TARGET_DEFERRED = 1

/** Target exhausted. */
export const TARGET_EXHAUSTED = 2

/** Target live. */
export const TARGET_LIVE = 0

/** Target retired. */
export const TARGET_RETIRED = 3

/** Tone accumulate fused. */
export const TONE_ACCUMULATE_FUSED = 0

/** Tone accumulate separate. */
export const TONE_ACCUMULATE_SEPARATE = 1

/** Tone analysis source samples. */
export const TONE_ANALYSIS_SOURCE_SAMPLES = 320

/** Tone budget. */
export const TONE_BUDGET = 0x30

/** Tone count bits. */
export const TONE_COUNT_BITS = 4

/** Tone crossfade decoder reconstruction. */
export const TONE_CROSSFADE_DECODER_RECONSTRUCTION = 1

/** Tone crossfade encoder residual. */
export const TONE_CROSSFADE_ENCODER_RESIDUAL = 0

/** Tone detection DFT words. */
export const TONE_DETECTION_DFT_WORDS = 132

/** Tone header allocation pointer word. */
export const TONE_HEADER_ALLOCATION_POINTER_WORD = 0xc3

/** Tone header band count word. */
export const TONE_HEADER_BAND_COUNT_WORD = 2

/** Tone header enable word. */
export const TONE_HEADER_ENABLE_WORD = 0

/** Tone header frequency array word. */
export const TONE_HEADER_FREQUENCY_ARRAY_WORD = 0xd8

/** Tone header frequency enable word. */
export const TONE_HEADER_FREQUENCY_ENABLE_WORD = 0xd6

/** Tone header frequency mode word. */
export const TONE_HEADER_FREQUENCY_MODE_WORD = 0xd7

/** Tone header joint array word. */
export const TONE_HEADER_JOINT_ARRAY_WORD = 0xc6

/** Tone header joint enable word. */
export const TONE_HEADER_JOINT_ENABLE_WORD = 0xc4

/** Tone header joint mode word. */
export const TONE_HEADER_JOINT_MODE_WORD = 0xc5

/** Tone header mode word. */
export const TONE_HEADER_MODE_WORD = 1

/** Tone header swap array word. */
export const TONE_HEADER_SWAP_ARRAY_WORD = 0xea

/** Tone header swap enable word. */
export const TONE_HEADER_SWAP_ENABLE_WORD = 0xe8

/** Tone header swap mode word. */
export const TONE_HEADER_SWAP_MODE_WORD = 0xe9

/** Tone invalid bits. */
export const TONE_INVALID_BITS = 0x4000

/** Tone item map length. */
export const TONE_ITEM_MAP_LENGTH = 0x30

/** Tone magnitude scale. */
export const TONE_MAGNITUDE_SCALE = Math.fround(0.9169922)

/** Tone max entries. */
export const TONE_MAX_ENTRIES = 16

/** Tone phase bits. */
export const TONE_PHASE_BITS = 5

/** Tone phase bucket scale. */
export const TONE_PHASE_BUCKET_SCALE = Math.fround(1 / 64)

/** Tone pre gate peak ratio. */
export const TONE_PRE_GATE_PEAK_RATIO = Math.fround(1.75)

/** Tone record count. */
export const TONE_RECORD_COUNT = 16

/** Tone residual slot. */
export const TONE_RESIDUAL_SLOT = 4

/** Tone retention ratio. */
export const TONE_RETENTION_RATIO = Math.fround(0.9)

/** Tone shared words. */
export const TONE_SHARED_WORDS = 250

/** Tone slot count. */
export const TONE_SLOT_COUNT = 5

/** Transforms spectral reconstruction noise scale. */
export const TRANSFORMS_SPECTRAL_RECONSTRUCTION_NOISE_SCALE = Math.fround(
  1 / 32768
)

/** Transforms subband noise noise scale. */
export const TRANSFORMS_SUBBAND_NOISE_NOISE_SCALE = Math.fround(1 / 32768)

/** Transforms subband noise subband samples. */
export const TRANSFORMS_SUBBAND_NOISE_SUBBAND_SAMPLES = 128

/** Transforms tone samples. */
export const TRANSFORMS_TONE_SAMPLES = 128

/** Type none. */
export const TYPE_NONE = 0

/** Type one bit. */
export const TYPE_ONE_BIT = 2

/** Type value. */
export const TYPE_VALUE = 1

/** WAVE default alignment samples. */
export const WAVE_DEFAULT_ALIGNMENT_SAMPLES = FRAME_SAMPLES + DELAY_SAMPLES

/** WAVE extension bytes. */
export const WAVE_EXTENSION_BYTES = 34

/** WAVE fact bytes. */
export const WAVE_FACT_BYTES = 12

/** WAVE format chunk bytes. */
export const WAVE_FORMAT_CHUNK_BYTES = 52

/** WAVE header bytes. */
export const WAVE_HEADER_BYTES = 100

/** Weight floor. */
export const WEIGHT_FLOOR = 0.01

/** Wide overshoot. */
export const WIDE_OVERSHOOT = Math.fround(1.259921)

/** Wide undershoot. */
export const WIDE_UNDERSHOOT = Math.fround(0.7937005)

/** Window edge 1. */
export const WINDOW_EDGE_1 = Math.fround(0.14642334)

/** Window edge 2. */
export const WINDOW_EDGE_2 = 0.5

/** Window edge 3. */
export const WINDOW_EDGE_3 = Math.fround(0.85357666)

/** Window samples. */
export const WINDOW_SAMPLES = 256

/** Word-length forbidden bits. */
export const WORD_LENGTH_FORBIDDEN_BITS = 0x4000

/** Word mask. */
export const WORD_MASK = 7

/** Analysis residual overlap samples. */
export const ANALYSIS_RESIDUAL_OVERLAP_SAMPLES =
  ANALYSIS_TAIL_SAMPLES - QMF_ANALYSIS_STARTUP_SKIP_SAMPLES

/** Analysis sample count. */
export const ANALYSIS_SAMPLE_COUNT = ANALYSIS_BANDS * BAND_STRIDE

/** Arena entries. */
export const ARENA_ENTRIES =
  ARENA_GENERATIONS * STATE_GAIN_ANALYSIS_GROUP_ENTRIES

/** Code-table context stride. */
export const CODE_TABLE_CONTEXT_STRIDE =
  SPECTRUM_MODE_COUNT * CODE_TABLE_MODE_STRIDE

/** Complete signal samples. */
export const COMPLETE_SIGNAL_SAMPLES =
  STATE_GAIN_ANALYSIS_GAIN_MAX_CHANNELS *
  STATE_GAIN_ANALYSIS_GAIN_BANDS *
  STATE_GAIN_ANALYSIS_GAIN_WINDOW_SAMPLES

/** Descriptors per context. */
export const DESCRIPTORS_PER_CONTEXT =
  SPECTRUM_CODE_TABLE_COUNT * SPECTRUM_MODE_COUNT

/** Gain detection samples. */
export const GAIN_DETECTION_SAMPLES =
  STATE_GAIN_ANALYSIS_GAIN_PREFIX_SAMPLES + 128

/** Gain event sample offset. */
export const GAIN_EVENT_SAMPLE_OFFSET =
  ANALYSIS_GAIN_ADJUSTMENT_GAIN_WINDOW_SAMPLES / 2

/** Gain point entry count. */
export const GAIN_POINT_ENTRY_COUNT =
  GAIN_POINT_GROUPS * GAIN_POINT_GROUP_ENTRIES

/** Offset max units. */
export const OFFSET_MAX_UNITS = 5 * OFFSET_SCALE

/** Offset min units. */
export const OFFSET_MIN_UNITS = -6 * OFFSET_SCALE

/** Tone source sample. */
export const TONE_SOURCE_SAMPLE = 4 * ANALYSIS_TONE_ANALYSIS_SUBBAND_SAMPLES

/** Gain control epsilon. */
export const GAIN_CONTROL_EPSILON = Math.fround(1e-8)

/** Gain control inverse 7. */
export const GAIN_CONTROL_INVERSE_7 = Math.fround(1 / 7)

/** Gain control scale. */
export const GAIN_CONTROL_SCALE = Math.fround(Math.fround(Math.LOG2E) / 8)

/** Correlation low. */
export const CORRELATION_LOW = 0.0010000001639127731

/** Correlation log scale. */
export const CORRELATION_LOG_SCALE = 8.68588924407959

/** Correlation low db. */
export const CORRELATION_LOW_DB = 59.999996185302734

/** Gain control span offset 8. */
export const GAIN_CONTROL_SPAN_OFFSET_8 = 0.07400058209896088

/** Gain control span offset 16. */
export const GAIN_CONTROL_SPAN_OFFSET_16 = 0.19264507293701172

/** Gain control span offset 32. */
export const GAIN_CONTROL_SPAN_OFFSET_32 = 0.32192808389663696

/** Gain control start offset. */
export const GAIN_CONTROL_START_OFFSET = 0.41503751277923584

/** Frame item kind. */
export const FRAME_ITEM_KIND = Object.freeze({
  CODING_UNIT: 0,
  TERMINATOR: 1,
})

/** Frame tag. */
export const FRAME_TAG = Object.freeze({
  MONO: 0,
  STEREO: 1,
  EXTENSION: 2,
  TERMINATOR: 3,
})

/** Gain role. */
export const GAIN_ROLE = Object.freeze({ PRIMARY: 0, SECONDARY: 1 })

/** Location codebook. */
export const LOCATION_CODEBOOK = Object.freeze({
  A_ATTACK: 0,
  A_RELEASE: 1,
  B_ATTACK: 2,
  B_RELEASE: 3,
  C_ATTACK: 4,
})
