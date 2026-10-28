/**
 * ============================================================================
 * LATEXGUARD — SMART LATEX QUALITY ASSESSMENT SYSTEM
 * Core Application Engine & Multi-Sensor Telemetry Processor
 * 
 * Target Hardware:
 *   - ESP32 Microcontroller (Wi-Fi HTTP REST Server at /data)
 *   - ams OSRAM AS7343 14-Channel Spectral Sensor (Primary Optical Detector)
 *   - Analog pH Sensor (Signal Conditioned)
 *   - Digital Relative Humidity Sensor (Ambient Enclosure Monitoring)
 * ============================================================================
 */

"use strict";

/* ==========================================================================
   1. GLOBAL CONFIGURATION & SENSOR CHANNEL DEFINITIONS
   ========================================================================== */

const CONFIG = {
  // ESP32 Wi-Fi REST endpoint
  sensorEndpoint: "http://192.168.220.139/data",
  pollingIntervalMs: 5000,
  requestTimeoutMs: 4000,
  staleAfterMs: 12000,
  historyLimit: 100,

  // Mode flag: false = Live Mode (polling ESP32); true = local Demo simulation
  demoMode: false,

  // Experimental calibration flag (Strict scientific protocol requires laboratory calibration)
  experimentalCalibrationEnabled: false
};

/**
 * AS7343 14-Channel Spectral Sensor Mapping:
 * Verified channel wavelengths and optical band classifications.
 * Note: Optical reflectance/absorption in natural rubber latex is governed by
 * Mie scattering of cis-1,4-polyisoprene colloidal spheres and serum protein absorption.
 */
const SPECTRAL_CHANNELS = [
  { id: "ch1",  code: "F1",    name: "Violet",         wavelength: "405 nm", band: "visible", maxAdc: 65535 },
  { id: "ch2",  code: "F2",    name: "Indigo",         wavelength: "425 nm", band: "visible", maxAdc: 65535 },
  { id: "ch3",  code: "F3",    name: "Blue",           wavelength: "445 nm", band: "visible", maxAdc: 65535 },
  { id: "ch4",  code: "F4",    name: "Cyan",           wavelength: "475 nm", band: "visible", maxAdc: 65535 },
  { id: "ch5",  code: "F5",    name: "Green",          wavelength: "515 nm", band: "visible", maxAdc: 65535 },
  { id: "ch6",  code: "F6",    name: "Yellow-Green",   wavelength: "555 nm", band: "visible", maxAdc: 65535 },
  { id: "ch7",  code: "F7",    name: "Amber",          wavelength: "590 nm", band: "visible", maxAdc: 65535 },
  { id: "ch8",  code: "F8",    name: "Red",            wavelength: "640 nm", band: "visible", maxAdc: 65535 },
  { id: "ch9",  code: "FZ",    name: "Blue Ref",       wavelength: "450 nm", band: "visible", maxAdc: 65535 },
  { id: "ch10", code: "FY",    name: "Visual Photopic",wavelength: "555 nm", band: "visible", maxAdc: 65535 },
  { id: "ch11", code: "FX",    name: "CIE X Tristim",  wavelength: "600 nm", band: "visible", maxAdc: 65535 },
  { id: "ch12", code: "NIR",   name: "Near-Infrared",  wavelength: "860 nm", band: "nir",     maxAdc: 65535 },
  { id: "ch13", code: "Clear", name: "Broadband Clear",wavelength: "Vis+NIR", band: "clear",   maxAdc: 65535 },
  { id: "ch14", code: "FD",    name: "Flicker/Visible",wavelength: "500-700nm",band: "clear",  maxAdc: 65535 }
];

/**
 * Grading thresholds for Latex Quality Assessment
 * Matches the updated ESP32 code prototype classifications:
 *   DRC >= 32.0%          -> GOOD, Grade A
 *   DRC >= 29.0% & < 32.0% -> MODERATE, Grade B
 *   DRC < 29.0%           -> LOW, Grade C
 */
const GRADING_CONFIG = {
  // Target pH boundaries for freshly tapped Field Latex
  ph: {
    freshMin: 6.20,
    freshMax: 7.20,
    preservedMin: 9.80, // High-ammonia preserved latex
    validMin: 4.0,
    validMax: 11.5
  },
  // Dry Rubber Content (DRC) benchmark guidelines
  drc: {
    gradeAMin: 32.0,  // Good quality
    gradeBMin: 29.0,  // Moderate quality
    validMin: 5.0,
    validMax: 65.0
  },
  // Humidity operating bounds (ambient environment monitoring)
  humidity: {
    validMin: 10.0,
    validMax: 99.0
  }
};

/* ==========================================================================
   2. APPLICATION STATE MANAGEMENT
   ========================================================================== */

const STATE = {
  // Connection states: "NOT CONNECTED" | "CONNECTING" | "CONNECTED" | "ERROR" | "STALE DATA"
  connectionStatus: "NOT CONNECTED",
  isMonitoring: false,
  isFetching: false,
  lastValidTelemetryTime: null,
  validSampleCount: 0,
  invalidSampleCount: 0,
  lastHttpStatus: null,
  sampleCounter: 0,

  // Current validated telemetry frame
  currentData: null,

  // Telemetry history buffer
  history: [],

  // Timers
  pollingTimer: null,
  stalenessCheckerTimer: null,
  activeAbortController: null
};

/* ==========================================================================
   3. DOM ELEMENT REFERENCES
   ========================================================================== */

const DOM = {
  // Header & Status
  connectionPill: document.getElementById("connection-pill"),
  connectionDot: document.getElementById("connection-dot"),
  connectionStatusText: document.getElementById("connection-status-text"),
  modePill: document.getElementById("mode-pill"),
  modeStatusText: document.getElementById("mode-status-text"),
  headerLastUpdate: document.getElementById("header-last-update"),

  // Sample Info Strip
  stripSampleId: document.getElementById("strip-sample-id"),
  stripSampleSource: document.getElementById("strip-sample-source"),
  stripDeviceId: document.getElementById("strip-device-id"),
  stripMode: document.getElementById("strip-mode"),
  stripIntegrity: document.getElementById("strip-integrity"),
  stripStaleness: document.getElementById("strip-staleness"),

  // Controls Toolbar
  btnStart: document.getElementById("btn-start"),
  btnStop: document.getElementById("btn-stop"),
  btnReconnect: document.getElementById("btn-reconnect"),
  btnToggleMode: document.getElementById("btn-toggle-mode"),
  btnClearHistory: document.getElementById("btn-clear-history"),
  btnExportCsv: document.getElementById("btn-export-csv"),
  btnToggleSettings: document.getElementById("btn-toggle-settings"),
  settingsDrawer: document.getElementById("settings-drawer"),
  cfgEndpoint: document.getElementById("cfg-endpoint"),
  btnSaveEndpoint: document.getElementById("btn-save-endpoint"),
  cfgInterval: document.getElementById("cfg-interval"),
  cfgEnableCalibration: document.getElementById("cfg-enable-calibration"),
  banner: document.getElementById("mode-warning-banner"),
  bannerText: document.getElementById("banner-text"),

  // Section C: DRC
  drcValueNumber: document.getElementById("drc-value-number"),
  drcValueUnit: document.getElementById("drc-value-unit"),
  drcStatusCaption: document.getElementById("drc-status-caption"),
  drcCalibrationBadge: document.getElementById("drc-calibration-badge"),
  drcMeterFill: document.getElementById("drc-meter-fill"),
  drcModelName: document.getElementById("drc-model-name"),
  drcCalState: document.getElementById("drc-cal-state"),
  drcSpectralInputs: document.getElementById("drc-spectral-inputs"),
  drcScientificValidity: document.getElementById("drc-scientific-validity"),

  // Section D: AS7343 Spectral
  spectralGrid: document.getElementById("spectral-channels-grid"),
  specPeakChannel: document.getElementById("spec-peak-channel"),
  specTotalFlux: document.getElementById("spec-total-flux"),
  specNirRatio: document.getElementById("spec-nir-ratio"),
  specActiveChannels: document.getElementById("spec-active-channels"),

  // Section E: Supporting Sensors
  phReadingVal: document.getElementById("ph-reading-val"),
  phStatusBadge: document.getElementById("ph-status-badge"),
  phTimestamp: document.getElementById("ph-timestamp"),
  phPointer: document.getElementById("ph-pointer"),
  phValidityText: document.getElementById("ph-validity-text"),
  phPreservationHint: document.getElementById("ph-preservation-hint"),

  humReadingVal: document.getElementById("hum-reading-val"),
  humStatusBadge: document.getElementById("hum-status-badge"),
  humTimestamp: document.getElementById("hum-timestamp"),
  humValidityText: document.getElementById("hum-validity-text"),
  humDewPoint: document.getElementById("hum-dew-point"),
  humContextTag: document.getElementById("hum-context-tag"),

  commsLinkBadge: document.getElementById("comms-link-badge"),
  commsTimestamp: document.getElementById("comms-timestamp"),
  commsEndpointDisplay: document.getElementById("comms-endpoint-display"),
  commsTimeSince: document.getElementById("comms-time-since"),
  commsValidCount: document.getElementById("comms-valid-count"),
  commsInvalidCount: document.getElementById("comms-invalid-count"),
  commsHttpCode: document.getElementById("comms-http-code"),

  // Section F: Quality Assessment
  qualityGradePill: document.getElementById("quality-grade-pill"),
  qualityGradeText: document.getElementById("quality-grade-text"),
  qualityHeadline: document.getElementById("quality-headline"),
  qualityDetail: document.getElementById("quality-detail"),
  critDrcState: document.getElementById("crit-drc-state"),
  critPhState: document.getElementById("crit-ph-state"),
  critHumState: document.getElementById("crit-hum-state"),
  critValidityState: document.getElementById("crit-validity-state"),

  // Section G: History Table
  historyTableBody: document.getElementById("history-table-body"),
  historyEmptyRow: document.getElementById("history-empty-row"),
  historyRowCount: document.getElementById("history-row-count")
};

/* ==========================================================================
   4. DATA ADAPTER & JSON TELEMETRY VALIDATION
   ========================================================================== */

/**
 * Maps and validates an incoming raw JSON payload from the ESP32 firmware.
 * Reads both the nested spectrum object and top-level channel fallbacks.
 * Accurately extracts sequence, DRC percent, quality assessment, and data source.
 *
 * @param {any} raw - Parsed JSON object from ESP32
 * @returns {{ isValid: boolean, sample: object|null, error: string|null }}
 */
function adaptAndValidateTelemetry(raw) {
  if (!raw || typeof raw !== "object") {
    return { isValid: false, sample: null, error: "Empty or non-object JSON payload received." };
  }

  // Device Identification
  const deviceId = typeof raw.deviceId === "string" && raw.deviceId.trim().length > 0
    ? raw.deviceId.trim()
    : "LatexGuard-ESP32";

  // Sequence & Sample Identification
  const sequence = typeof raw.sequence === "number" && !isNaN(raw.sequence)
    ? raw.sequence
    : null;

  let sampleId = null;
  let isSampleIdGenerated = false;
  if (typeof raw.sampleId === "string" && raw.sampleId.trim().length > 0) {
    sampleId = raw.sampleId.trim();
  } else if (sequence !== null) {
    sampleId = `LG-${String(sequence).padStart(6, "0")}`;
  } else {
    STATE.sampleCounter++;
    sampleId = `LG-LOCAL-${String(STATE.sampleCounter).padStart(4, "0")}`;
    isSampleIdGenerated = true;
  }

  // Timestamp extraction
  let timestamp = null;
  if (raw.timestamp && !isNaN(new Date(raw.timestamp).getTime())) {
    timestamp = new Date(raw.timestamp).toISOString();
  } else {
    timestamp = new Date().toISOString();
  }

  // 1. AS7343 Multi-Spectral Data Validation
  // Uses nested spectrum object when available, with top-level channel values as fallback
  const spectralValues = {};
  let validChannelsCount = 0;
  const nestedSpectrum = (raw.spectrum && typeof raw.spectrum === "object") ? raw.spectrum : null;

  SPECTRAL_CHANNELS.forEach((ch, idx) => {
    let val = null;

    // Check nested spectrum object first
    if (nestedSpectrum) {
      if (Array.isArray(nestedSpectrum)) {
        val = nestedSpectrum[idx];
      } else {
        val = nestedSpectrum[ch.id] ??
              nestedSpectrum[`channel${idx + 1}`] ??
              nestedSpectrum[ch.code.toLowerCase()] ??
              nestedSpectrum[ch.code];
      }
    }

    // Fallback to top-level channel fields (data.ch1 .. data.ch14 or data.channel1..)
    if (val === null || val === undefined) {
      val = raw[ch.id] ??
            raw[`channel${idx + 1}`] ??
            raw[ch.code.toLowerCase()] ??
            raw[ch.code];
    }

    if (typeof val === "number" && !isNaN(val) && isFinite(val) && val >= 0) {
      spectralValues[ch.id] = Math.round(val);
      validChannelsCount++;
    } else {
      // Mark explicitly missing — NEVER fabricate or replace with zero!
      spectralValues[ch.id] = null;
    }
  });

  // 2. pH Sensor Validation
  let phValue = null;
  let phValid = false;
  const rawPh = raw.ph ?? raw.pH ?? raw.phValue;
  if (typeof rawPh === "number" && !isNaN(rawPh) && isFinite(rawPh)) {
    if (rawPh >= GRADING_CONFIG.ph.validMin && rawPh <= GRADING_CONFIG.ph.validMax) {
      phValue = parseFloat(rawPh.toFixed(2));
      phValid = true;
    }
  }

  // 3. Humidity Sensor Validation
  let humValue = null;
  let humValid = false;
  const rawHum = raw.humidity ?? raw.rh ?? raw.hum;
  if (typeof rawHum === "number" && !isNaN(rawHum) && isFinite(rawHum)) {
    if (rawHum >= GRADING_CONFIG.humidity.validMin && rawHum <= GRADING_CONFIG.humidity.validMax) {
      humValue = parseFloat(rawHum.toFixed(1));
      humValid = true;
    }
  }

  const humidityType = typeof raw.humidityType === "string" ? raw.humidityType : "ambient";

  // 4. DRC Percent & Status from ESP32
  let drcPercent = null;
  if (typeof raw.drcPercent === "number" && !isNaN(raw.drcPercent) && isFinite(raw.drcPercent)) {
    drcPercent = parseFloat(raw.drcPercent.toFixed(1));
  } else if (typeof raw.drc === "number" && !isNaN(raw.drc) && isFinite(raw.drc)) {
    drcPercent = parseFloat(raw.drc.toFixed(1));
  }

  const drcStatus = typeof raw.drcStatus === "string" ? raw.drcStatus.trim() : null;

  // 5. Quality Assessment & Grade
  // Remove the word DEMO from all visible quality assessment and grade labels
  let qualityAssessment = typeof raw.qualityAssessment === "string"
    ? raw.qualityAssessment.replace(/\bDEMO\s*/gi, "").trim()
    : null;

  let qualityGrade = typeof raw.qualityGrade === "string"
    ? raw.qualityGrade.replace(/\bDEMO\s*/gi, "").trim()
    : null;

  let qualityDetail = typeof raw.qualityDetail === "string"
    ? raw.qualityDetail.replace(/\bDEMO\s*/gi, "").trim()
    : null;

  // 6. Data Source & Simulation Flags
  const isSimulated = !!raw._isSimulated;
  const dataSource = typeof raw.dataSource === "string"
    ? raw.dataSource.trim()
    : (isSimulated ? "STORED_DATASET" : "PHYSICAL_SENSOR");

  // Data Completeness & Integrity Classification
  const hasMinSpectrum = validChannelsCount >= 10;
  const isOverallValid = hasMinSpectrum && phValid;

  return {
    isValid: isOverallValid,
    error: isOverallValid ? null : `Partial packet: Spectral channels (${validChannelsCount}/14), pH (${phValid ? "OK" : "Invalid/Missing"})`,
    sample: {
      deviceId,
      sampleId,
      sequence,
      isSampleIdGenerated,
      timestamp,
      spectrum: spectralValues,
      validChannelsCount,
      ph: phValue,
      phValid,
      humidity: humValue,
      humidityValid: humValid,
      humidityType,
      drcPercent,
      drcStatus,
      qualityAssessment,
      qualityGrade,
      qualityDetail,
      dataSource,
      isOverallValid,
      isSimulated
    }
  };
}

/* ==========================================================================
   5. SECTION C — DRC ESTIMATION MODULE
   ========================================================================== */

/**
 * Calculates Dry Rubber Content (DRC) or utilizes incoming ESP32 DRC estimation.
 * Keeps calibration status strictly distinct from measurements.
 *
 * @param {object} sample - Validated sample object
 * @param {object} calibrationConfig - Model coefficients and verification flags
 * @returns {{
 *   drc: number|null,
 *   status: string,
 *   isCalibrated: boolean,
 *   method: string,
 *   detail: string
 * }}
 */
function estimateDRC(sample, calibrationConfig) {
  if (!sample) {
    return {
      drc: null,
      status: "NO DATA",
      isCalibrated: false,
      method: "None",
      detail: "No sensor data available."
    };
  }

  // 1. If ESP32 provides drcPercent in its telemetry:
  if (sample.drcPercent !== null && sample.drcPercent !== undefined) {
    const statusNote = sample.drcStatus || "Pending laboratory validation";
    return {
      drc: sample.drcPercent,
      status: statusNote,
      isCalibrated: true,
      method: "ESP32 Regression (Prototype Dataset)",
      detail: `DRC calibration: ${statusNote}`
    };
  }

  // 2. If experimental browser calibration is toggled in Settings Drawer:
  if (calibrationConfig && calibrationConfig.enabled && sample.spectrum) {
    const ch1 = sample.spectrum.ch1;
    const ch5 = sample.spectrum.ch5;
    const ch8 = sample.spectrum.ch8;
    const ch12 = sample.spectrum.ch12;

    if (ch1 === null || ch5 === null || ch8 === null || ch12 === null) {
      return {
        drc: null,
        status: "INCOMPLETE SPECTRUM",
        isCalibrated: false,
        method: "Multi-Band Optical Ratio",
        detail: "Key optical channels required for calibrated DRC regression are unavailable."
      };
    }

    const ratioNirVis = (ch12 + 1) / (ch1 + 1);
    const ratioRedGreen = (ch8 + 1) / (ch5 + 1);
    let rawDrc = 24.5 + (7.8 * Math.log(ratioNirVis)) + (4.2 * (ratioRedGreen - 1.0));
    rawDrc = Math.max(10.0, Math.min(55.0, rawDrc));

    return {
      drc: parseFloat(rawDrc.toFixed(1)),
      status: "EXPERIMENTAL VALIDATION",
      isCalibrated: true,
      method: "Multi-Band Optical Attenuation Model",
      detail: "DRC calibration: Pending laboratory validation"
    };
  }

  // 3. Uncalibrated default:
  return {
    drc: null,
    status: "CALIBRATION REQUIRED",
    isCalibrated: false,
    method: "Uncalibrated",
    detail: "DRC estimation requires calibration with reference laboratory measurements."
  };
}

/* ==========================================================================
   6. SECTION F — LATEX QUALITY CLASSIFICATION MODULE
   ========================================================================== */

/**
 * Evaluates comprehensive latex quality grade using values returned by the ESP32.
 * Removes all "DEMO" labels.
 * Illustrative thresholds:
 *   DRC >= 32.0% -> GOOD, Grade A
 *   DRC >= 29.0% and < 32.0% -> MODERATE, Grade B
 *   DRC < 29.0%  -> LOW, Grade C
 *
 * @param {object} sample - Validated sample object
 * @param {object} drcResult - Output from estimateDRC
 * @param {object} gradingConfig - Threshold configuration
 * @returns {{
 *   assessment: string,
 *   grade: string,
 *   displayTitle: string,
 *   headline: string,
 *   detail: string,
 *   drcState: string,
 *   phState: string,
 *   humState: string,
 *   validityState: string
 * }}
 */
function classifyLatexQuality(sample, drcResult, gradingConfig) {
  if (!sample || !sample.isOverallValid) {
    return {
      assessment: "UNKNOWN",
      grade: "PENDING DATA",
      displayTitle: "PENDING DATA",
      headline: "Quality grade pending complete sensor acquisition.",
      detail: "Acquiring required optical and electrochemical signals from instrumentation.",
      drcState: "No Input",
      phState: "No Input",
      humState: "No Input",
      validityState: "Invalid Telemetry"
    };
  }

  // Evaluate pH status
  let phAssessment = "Nominal";
  if (sample.ph !== null) {
    if (sample.ph >= gradingConfig.ph.freshMin && sample.ph <= gradingConfig.ph.freshMax) {
      phAssessment = `Optimal Fresh (${sample.ph.toFixed(2)})`;
    } else if (sample.ph >= gradingConfig.ph.preservedMin) {
      phAssessment = `Ammonia Preserved (${sample.ph.toFixed(2)})`;
    } else if (sample.ph < gradingConfig.ph.freshMin) {
      phAssessment = `Acidic / Coagulating (${sample.ph.toFixed(2)})`;
    } else {
      phAssessment = `Alkaline (${sample.ph.toFixed(2)})`;
    }
  } else {
    phAssessment = "Unavailable";
  }

  // Humidity state (strictly environmental)
  const humAssessment = sample.humidity !== null
    ? `${sample.humidity.toFixed(1)}% RH (${sample.humidityType})`
    : "Unavailable";

  // Optical channel count validity
  const validityAssessment = sample.validChannelsCount === 14
    ? "14/14 Channels Verified"
    : `${sample.validChannelsCount}/14 Channels`;

  // Prefer quality info from sample (ESP32)
  let assessment = sample.qualityAssessment;
  let grade = sample.qualityGrade;
  let detail = sample.qualityDetail;

  const drcVal = sample.drcPercent ?? drcResult?.drc;

  // Fallback to DRC-based classification if ESP32 fields are missing:
  if (!assessment || !grade) {
    if (drcVal !== null && drcVal !== undefined) {
      if (drcVal >= 32.0) {
        assessment = "GOOD";
        grade = "Grade A";
        detail = detail || "Higher DRC category (DRC ≥ 32.0%)";
      } else if (drcVal >= 29.0) {
        assessment = "MODERATE";
        grade = "Grade B";
        detail = detail || "Medium DRC category (29.0% ≤ DRC < 32.0%)";
      } else {
        assessment = "LOW";
        grade = "Grade C";
        detail = detail || "Lower DRC category (DRC < 29.0%)";
      }
    } else {
      assessment = "PENDING";
      grade = "Pending Calibration";
      detail = "Quality grade pending validated calibration and grading rules.";
    }
  }

  // Remove the word DEMO from visible labels
  assessment = (assessment || "").replace(/\bDEMO\s*/gi, "").trim();
  grade = (grade || "").replace(/\bDEMO\s*/gi, "").trim();
  detail = (detail || "").replace(/\bDEMO\s*/gi, "").trim();

  // Unified display title: "GOOD — Grade A" / "MODERATE — Grade B" / "LOW — Grade C"
  const displayTitle = assessment && grade && assessment !== grade
    ? `${assessment} — ${grade}`
    : (grade || assessment || "Pending Rules");

  return {
    assessment,
    grade,
    displayTitle,
    headline: displayTitle,
    detail: detail || "Natural rubber latex multi-parametric assessment.",
    drcState: drcVal !== null ? `${drcVal}% DRC` : "Uncalibrated",
    phState: phAssessment,
    humState: humAssessment,
    validityState: validityAssessment
  };
}

/* ==========================================================================
   7. DEMO MODE SIMULATOR (Browser-Generated Prototype Values)
   ========================================================================== */

/**
 * Generates browser-side demonstration readings.
 * Matches the updated ESP32 schema (nested spectrum + top-level channels).
 * Does NOT include the word "DEMO" in quality labels.
 */
function generateSimulatedTelemetry() {
  STATE.sampleCounter++;
  const now = new Date();

  // Emulate stored dataset cycling
  const baseScatter = 740 + Math.sin(STATE.sampleCounter * 0.2) * 80;

  const mockSpectrum = {
    ch1:  Math.round(baseScatter * 1.10 + (Math.random() * 20 - 10)),
    ch2:  Math.round(baseScatter * 1.06 + (Math.random() * 20 - 10)),
    ch3:  Math.round(baseScatter * 1.02 + (Math.random() * 20 - 10)),
    ch4:  Math.round(baseScatter * 0.98 + (Math.random() * 20 - 10)),
    ch5:  Math.round(baseScatter * 0.94 + (Math.random() * 20 - 10)),
    ch6:  Math.round(baseScatter * 0.91 + (Math.random() * 16 - 8)),
    ch7:  Math.round(baseScatter * 0.87 + (Math.random() * 16 - 8)),
    ch8:  Math.round(baseScatter * 0.83 + (Math.random() * 16 - 8)),
    ch9:  Math.round(baseScatter * 0.80 + (Math.random() * 16 - 8)),
    ch10: Math.round(baseScatter * 0.77 + (Math.random() * 16 - 8)),
    ch11: Math.round(baseScatter * 0.74 + (Math.random() * 16 - 8)),
    ch12: Math.round(baseScatter * 0.72 + (Math.random() * 16 - 8)),
    ch13: Math.round(baseScatter * 0.69 + (Math.random() * 16 - 8)),
    ch14: Math.round(baseScatter * 0.66 + (Math.random() * 16 - 8))
  };

  const mockPh = parseFloat((6.75 + Math.sin(STATE.sampleCounter * 0.12) * 0.15).toFixed(2));
  const mockHum = parseFloat((65.0 + Math.cos(STATE.sampleCounter * 0.08) * 3.0).toFixed(1));
  const mockDrc = parseFloat((32.5 + Math.sin(STATE.sampleCounter * 0.15) * 3.5).toFixed(1));

  let qualityAssessment = "GOOD";
  let qualityGrade = "Grade A";
  let qualityDetail = "Higher DRC category";
  if (mockDrc < 29.0) {
    qualityAssessment = "LOW";
    qualityGrade = "Grade C";
    qualityDetail = "Lower DRC category";
  } else if (mockDrc < 32.0) {
    qualityAssessment = "MODERATE";
    qualityGrade = "Grade B";
    qualityDetail = "Medium DRC category";
  }

  return {
    deviceId: "LatexGuard-ESP32",
    sampleId: `LG-${String(STATE.sampleCounter).padStart(6, "0")}`,
    sequence: STATE.sampleCounter,
    spectrum: mockSpectrum,
    ...mockSpectrum,
    ph: mockPh,
    humidity: mockHum,
    humidityType: "ambient",
    drcPercent: mockDrc,
    qualityAssessment,
    qualityGrade,
    qualityDetail,
    drcStatus: "NOT LABORATORY CALIBRATED",
    _isSimulated: true,
    dataSource: "STORED_DATASET"
  };
}

/* ==========================================================================
   8. ESP32 HTTP COMMUNICATION & POLLING ENGINE
   ========================================================================== */

/**
 * Executes periodic telemetry acquisition.
 * In Demo Mode: generates local simulation without calling the ESP32 endpoint,
 * and maintains ESP32 connection status as NOT CONNECTED.
 * In Live Mode: fetches http://192.168.220.139/data with cache-busting and error handling.
 */
async function fetchSensorTelemetry() {
  if (STATE.isFetching) return; // Prevent overlapping requests
  STATE.isFetching = true;

  // DEMO MODE: Local simulation only — Do NOT fetch from ESP32
  if (CONFIG.demoMode) {
    const rawDemo = generateSimulatedTelemetry();
    const result = adaptAndValidateTelemetry(rawDemo);
    if (result.isValid && result.sample) {
      handleTelemetrySuccess(result.sample, 200);
    }
    // MANDATORY: Demo Mode must always show ESP32 as NOT CONNECTED
    updateConnectionState("NOT CONNECTED");
    STATE.isFetching = false;
    return;
  }

  // LIVE MODE: Real network request via Fetch API to ESP32
  updateConnectionState("CONNECTING");

  const abortController = new AbortController();
  STATE.activeAbortController = abortController;
  const timeoutId = setTimeout(() => abortController.abort(), CONFIG.requestTimeoutMs);

  try {
    // Cache-busting query parameter
    const cacheBuster = `_t=${Date.now()}`;
    const sep = CONFIG.sensorEndpoint.includes("?") ? "&" : "?";
    const targetUrl = `${CONFIG.sensorEndpoint}${sep}${cacheBuster}`;

    const response = await fetch(targetUrl, {
      method: "GET",
      headers: { "Accept": "application/json" },
      signal: abortController.signal
    });

    clearTimeout(timeoutId);
    STATE.lastHttpStatus = response.status;
    DOM.commsHttpCode.textContent = `${response.status} ${response.statusText}`;

    if (!response.ok) {
      throw new Error(`HTTP Error ${response.status}: ${response.statusText}`);
    }

    const json = await response.json();
    const result = adaptAndValidateTelemetry(json);

    if (result.isValid && result.sample) {
      STATE.validSampleCount++;
      handleTelemetrySuccess(result.sample, response.status);
      updateConnectionState("CONNECTED");
    } else {
      STATE.invalidSampleCount++;
      handleTelemetryInvalid(result.error || "Malformed sensor payload.");
      updateConnectionState("NOT CONNECTED");
    }
  } catch (err) {
    clearTimeout(timeoutId);
    STATE.invalidSampleCount++;

    if (err.name === "AbortError") {
      handleTelemetryFailure(`Connection timeout (> ${CONFIG.requestTimeoutMs}ms). Check ESP32 Wi-Fi.`);
    } else {
      handleTelemetryFailure(err.message || "Failed to reach ESP32 endpoint.");
    }
    // Live mode request failed: must display NOT CONNECTED
    updateConnectionState("NOT CONNECTED");
  } finally {
    STATE.isFetching = false;
    STATE.activeAbortController = null;
    updateCommsMetricsDisplay();
  }
}

/**
 * Handles successfully parsed telemetry packet.
 */
function handleTelemetrySuccess(sample, httpStatus) {
  STATE.lastValidTelemetryTime = new Date();
  STATE.currentData = sample;

  // Process DRC and Quality Grading
  const drcResult = estimateDRC(sample, {
    enabled: CONFIG.experimentalCalibrationEnabled
  });

  const qualityResult = classifyLatexQuality(sample, drcResult, GRADING_CONFIG);

  // Update UI Panels
  renderSampleInfo(sample);
  renderDrcPanel(drcResult);
  renderSpectralGrid(sample.spectrum);
  renderSupportingSensors(sample);
  renderQualityPanel(qualityResult);

  // Append to Session History (with duplicate prevention)
  addHistoryRecord(sample, drcResult, qualityResult);

  // Update Header Last Telemetry Time
  const timeStr = STATE.lastValidTelemetryTime.toLocaleTimeString();
  DOM.headerLastUpdate.textContent = timeStr;
  
  if (!CONFIG.demoMode) {
    DOM.stripStaleness.textContent = "Live";
    DOM.stripStaleness.style.color = "var(--primary-green)";
  } else {
    DOM.stripStaleness.textContent = "Simulated";
    DOM.stripStaleness.style.color = "var(--text-secondary)";
  }
}

/**
 * Handles malformed or partial telemetry.
 */
function handleTelemetryInvalid(errorMsg) {
  DOM.stripIntegrity.textContent = "Data Incomplete";
  DOM.stripIntegrity.style.color = "var(--status-stale)";
  console.warn("[LatexGuard Validation Warning]:", errorMsg);
}

/**
 * Handles communication failures (network error, timeout, offline device).
 */
function handleTelemetryFailure(errMsg) {
  DOM.commsHttpCode.textContent = "ERR_CONNECTION";
  DOM.stripIntegrity.textContent = "Offline / No Signal";
  DOM.stripIntegrity.style.color = "var(--status-error)";
  console.error("[LatexGuard Telemetry Error]:", errMsg);

  // Preserve existing readings but mark them as stale/offline
  checkStaleness();
}

/**
 * Periodically verifies if telemetry is stale.
 */
function checkStaleness() {
  if (!STATE.lastValidTelemetryTime) {
    DOM.commsTimeSince.textContent = "Never";
    return;
  }

  const elapsedMs = Date.now() - STATE.lastValidTelemetryTime.getTime();
  const seconds = Math.floor(elapsedMs / 1000);
  DOM.commsTimeSince.textContent = `${seconds}s ago`;

  if (!CONFIG.demoMode && elapsedMs > CONFIG.staleAfterMs) {
    DOM.stripStaleness.textContent = `STALE (${seconds}s)`;
    DOM.stripStaleness.style.color = "var(--status-stale)";

    if (STATE.connectionStatus === "CONNECTED") {
      updateConnectionState("STALE DATA");
    }
  }
}

/**
 * Updates UI connection badges.
 * Ensures Demo Mode and failed Live Mode requests display "ESP32: NOT CONNECTED".
 */
function updateConnectionState(newState) {
  STATE.connectionStatus = newState;
  
  DOM.connectionPill.className = "connection-pill";
  DOM.commsLinkBadge.className = "sub-badge";

  switch (newState) {
    case "CONNECTED":
      DOM.connectionStatusText.textContent = "ESP32: CONNECTED";
      DOM.connectionPill.classList.add("state-connected");
      DOM.commsLinkBadge.classList.add("state-ok");
      DOM.commsLinkBadge.textContent = "CONNECTED";
      break;

    case "CONNECTING":
      DOM.connectionStatusText.textContent = "ESP32: CONNECTING...";
      DOM.connectionPill.classList.add("state-connecting");
      DOM.commsLinkBadge.classList.add("state-warn");
      DOM.commsLinkBadge.textContent = "CONNECTING...";
      break;

    case "STALE DATA":
      DOM.connectionStatusText.textContent = "ESP32: STALE DATA";
      DOM.connectionPill.classList.add("state-stale");
      DOM.commsLinkBadge.classList.add("state-warn");
      DOM.commsLinkBadge.textContent = "STALE DATA";
      break;

    case "ERROR":
    case "DISCONNECTED":
    case "NOT CONNECTED":
    default:
      DOM.connectionStatusText.textContent = "ESP32: NOT CONNECTED";
      DOM.connectionPill.classList.add("state-disconnected");
      DOM.commsLinkBadge.classList.add("state-disconnected");
      DOM.commsLinkBadge.textContent = "NOT CONNECTED";
      break;
  }
}

function updateCommsMetricsDisplay() {
  DOM.commsValidCount.textContent = STATE.validSampleCount;
  DOM.commsInvalidCount.textContent = STATE.invalidSampleCount;
  DOM.commsEndpointDisplay.textContent = CONFIG.sensorEndpoint;
}

/* ==========================================================================
   9. UI RENDERING ENGINES
   ========================================================================== */

/**
 * Initializes the 14-Channel AS7343 measurement grid HTML.
 */
function initSpectralGrid() {
  DOM.spectralGrid.innerHTML = "";

  SPECTRAL_CHANNELS.forEach(ch => {
    const cell = document.createElement("div");
    cell.className = `channel-cell band-${ch.band}`;
    cell.id = `spec-cell-${ch.id}`;

    cell.innerHTML = `
      <div class="channel-top-row">
        <span class="channel-id">${ch.code}</span>
        <span class="channel-wavelength">${ch.wavelength}</span>
      </div>
      <div class="channel-value-row">
        <span class="channel-raw-num" id="spec-val-${ch.id}">—</span>
        <span class="channel-norm-pct" id="spec-pct-${ch.id}">—</span>
      </div>
      <div class="channel-bar-wrap">
        <div class="channel-bar-fill" id="spec-bar-${ch.id}" style="width: 0%;"></div>
      </div>
    `;

    DOM.spectralGrid.appendChild(cell);
  });
}

/**
 * Updates the 14-Channel AS7343 displays from incoming readings.
 */
function renderSpectralGrid(spectrum) {
  if (!spectrum) return;

  let peakVal = -1;
  let peakChannelCode = "—";
  let totalFlux = 0;
  let activeCount = 0;

  // Find peak for normalized bar calculations
  SPECTRAL_CHANNELS.forEach(ch => {
    const val = spectrum[ch.id];
    if (typeof val === "number" && val > peakVal) {
      peakVal = val;
      peakChannelCode = `${ch.code} (${ch.wavelength})`;
    }
    if (typeof val === "number") {
      totalFlux += val;
      activeCount++;
    }
  });

  const normalizer = peakVal > 0 ? peakVal : 1;

  SPECTRAL_CHANNELS.forEach(ch => {
    const val = spectrum[ch.id];
    const valEl = document.getElementById(`spec-val-${ch.id}`);
    const pctEl = document.getElementById(`spec-pct-${ch.id}`);
    const barEl = document.getElementById(`spec-bar-${ch.id}`);
    const cellEl = document.getElementById(`spec-cell-${ch.id}`);

    if (typeof val === "number") {
      const normPct = Math.round((val / normalizer) * 100);
      valEl.textContent = val.toLocaleString();
      pctEl.textContent = `${normPct}%`;
      barEl.style.width = `${normPct}%`;

      if (val === peakVal && peakVal > 0) {
        cellEl.classList.add("is-peak");
      } else {
        cellEl.classList.remove("is-peak");
      }
    } else {
      valEl.textContent = "—";
      pctEl.textContent = "—";
      barEl.style.width = "0%";
      cellEl.classList.remove("is-peak");
    }
  });

  DOM.specPeakChannel.textContent = peakChannelCode;
  DOM.specTotalFlux.textContent = totalFlux > 0 ? totalFlux.toLocaleString() : "—";
  DOM.specActiveChannels.textContent = `${activeCount} / 14`;

  // NIR / Visible Ratio calculation (F1 @ 405nm vs NIR @ 860nm)
  if (typeof spectrum.ch1 === "number" && typeof spectrum.ch12 === "number" && spectrum.ch1 > 0) {
    const ratio = (spectrum.ch12 / spectrum.ch1).toFixed(2);
    DOM.specNirRatio.textContent = `${ratio} (NIR:F1)`;
  } else {
    DOM.specNirRatio.textContent = "—";
  }
}

/**
 * Updates Section B: Sample Information Strip.
 */
function renderSampleInfo(sample) {
  DOM.stripSampleId.textContent = sample.sampleId || "—";
  DOM.stripSampleSource.textContent = sample.isSampleIdGenerated ? "Local Gen" : (sample.dataSource || "ESP32 HW");
  DOM.stripDeviceId.textContent = sample.deviceId || "—";
  DOM.stripMode.textContent = sample.isSimulated ? "DEMO SIMULATION" : "LIVE SENSOR";
  DOM.stripMode.className = sample.isSimulated ? "strip-value" : "strip-value highlight";

  DOM.stripIntegrity.textContent = sample.isOverallValid ? "Valid Telemetry" : "Degraded / Partial";
  DOM.stripIntegrity.style.color = sample.isOverallValid ? "var(--primary-green)" : "var(--status-stale)";
}

/**
 * Updates Section C: DRC Primary Analysis Panel.
 */
function renderDrcPanel(drcResult) {
  if (drcResult.drc !== null && drcResult.drc !== undefined) {
    DOM.drcValueNumber.textContent = drcResult.drc.toFixed(1);
    DOM.drcValueUnit.style.display = "inline";
    DOM.drcStatusCaption.textContent = drcResult.detail;
    DOM.drcCalibrationBadge.textContent = drcResult.status;
    DOM.drcCalibrationBadge.className = "badge cal-pending";

    // Update meter fill (Scale: 0 to 60%)
    const pct = Math.min(100, Math.max(0, (drcResult.drc / 60) * 100));
    DOM.drcMeterFill.style.width = `${pct}%`;

    DOM.drcCalState.textContent = "Pending Laboratory Validation";
    DOM.drcScientificValidity.textContent = "Stored Dataset / Prototype";
  } else {
    DOM.drcValueNumber.textContent = "—";
    DOM.drcValueUnit.style.display = "none";
    DOM.drcStatusCaption.textContent = "DRC estimation requires calibration with reference laboratory measurements.";
    DOM.drcCalibrationBadge.textContent = "CALIBRATION REQUIRED";
    DOM.drcCalibrationBadge.className = "badge cal-pending";
    DOM.drcMeterFill.style.width = "0%";

    DOM.drcCalState.textContent = "Pending Reference Calibration";
    DOM.drcScientificValidity.textContent = "Awaiting Reference Standard";
  }
}

/**
 * Updates Section E: Supporting Sensor Panels (pH, Humidity, Comms).
 */
function renderSupportingSensors(sample) {
  const timeStr = new Date(sample.timestamp).toLocaleTimeString();

  // 1. pH Sensor
  DOM.phTimestamp.textContent = timeStr;
  if (sample.ph !== null && sample.phValid) {
    DOM.phReadingVal.textContent = sample.ph.toFixed(2);
    DOM.phValidityText.textContent = "Signal Stable";
    DOM.phStatusBadge.className = "sub-badge state-ok";
    DOM.phStatusBadge.textContent = "VALID";

    // Visual pointer mapping: pH range 4.0 to 10.0 mapped to 0% - 100%
    const phOffset = Math.min(100, Math.max(0, ((sample.ph - 4.0) / (10.0 - 4.0)) * 100));
    DOM.phPointer.style.left = `${phOffset}%`;

    if (sample.ph >= 6.2 && sample.ph <= 7.2) {
      DOM.phPreservationHint.textContent = "Fresh Field Latex Range";
      DOM.phPreservationHint.style.color = "var(--primary-green)";
    } else if (sample.ph >= 9.8) {
      DOM.phPreservationHint.textContent = "Preserved with Ammonia";
      DOM.phPreservationHint.style.color = "#2B6CB0";
    } else {
      DOM.phPreservationHint.textContent = "Acidic / Pre-Coagulation Risk";
      DOM.phPreservationHint.style.color = "var(--status-error)";
    }
  } else {
    DOM.phReadingVal.textContent = "—";
    DOM.phValidityText.textContent = "Invalid / Unconnected";
    DOM.phStatusBadge.className = "sub-badge state-warn";
    DOM.phStatusBadge.textContent = "INVALID";
    DOM.phPreservationHint.textContent = "Awaiting reading";
  }

  // 2. Humidity Sensor
  DOM.humTimestamp.textContent = timeStr;
  if (sample.humidity !== null && sample.humidityValid) {
    DOM.humReadingVal.textContent = sample.humidity.toFixed(1);
    DOM.humValidityText.textContent = "Calibrated Sensor";
    DOM.humStatusBadge.className = "sub-badge state-ok";
    DOM.humStatusBadge.textContent = "VALID";
    DOM.humContextTag.textContent = `Context: ${sample.humidityType === "enclosure" ? "Sample Chamber" : "Ambient Enclosure"}`;

    // Magnus formula dew point estimate assuming 26°C ambient
    const tempApprox = 26.0;
    const dewPoint = (tempApprox - ((100 - sample.humidity) / 5)).toFixed(1);
    DOM.humDewPoint.textContent = `${dewPoint} °C (at ~26°C)`;
  } else {
    DOM.humReadingVal.textContent = "—";
    DOM.humValidityText.textContent = "Invalid / Disconnected";
    DOM.humStatusBadge.className = "sub-badge state-warn";
    DOM.humStatusBadge.textContent = "INVALID";
    DOM.humDewPoint.textContent = "—";
  }

  // 3. Comms Panel
  DOM.commsTimestamp.textContent = timeStr;
}

/**
 * Updates Section F: Latex Quality Assessment Card.
 */
function renderQualityPanel(quality) {
  DOM.qualityGradeText.textContent = quality.displayTitle;
  DOM.qualityHeadline.textContent = quality.headline;
  DOM.qualityDetail.textContent = quality.detail;

  DOM.critDrcState.textContent = quality.drcState;
  DOM.critPhState.textContent = quality.phState;
  DOM.critHumState.textContent = quality.humState;
  DOM.critValidityState.textContent = quality.validityState;

  // Grade pill styling
  DOM.qualityGradePill.className = "quality-grade-pill";
  if (quality.grade.includes("Grade A")) DOM.qualityGradePill.classList.add("grade-a");
  else if (quality.grade.includes("Grade B")) DOM.qualityGradePill.classList.add("grade-b");
  else if (quality.grade.includes("Grade C")) DOM.qualityGradePill.classList.add("grade-c");
  else if (quality.grade.includes("Testing")) DOM.qualityGradePill.classList.add("grade-testing");
}

/* ==========================================================================
   10. SECTION G — DATA HISTORY & CSV EXPORT
   ========================================================================== */

/**
 * Appends a new validated telemetry record to memory and the DOM table.
 * Prevents duplicate entries using sampleId or sequence number.
 */
function addHistoryRecord(sample, drcResult, qualityResult) {
  // Prevent duplicate entries in sample history using sampleId or sequence number
  if (STATE.history.length > 0) {
    const isDuplicate = STATE.history.some(rec => 
      (sample.sampleId && rec.sampleId === sample.sampleId) ||
      (sample.sequence !== null && sample.sequence !== undefined && rec.sequence === sample.sequence)
    );
    if (isDuplicate) {
      return; // Skip duplicate history entry
    }
  }

  // Peak spectral channel identifier
  let peakCh = "—";
  let peakVal = -1;
  SPECTRAL_CHANNELS.forEach(ch => {
    const val = sample.spectrum[ch.id];
    if (typeof val === "number" && val > peakVal) {
      peakVal = val;
      peakCh = `${ch.code} (${val})`;
    }
  });

  const record = {
    timestamp: new Date(sample.timestamp).toLocaleTimeString(),
    fullIso: sample.timestamp,
    sampleId: sample.sampleId,
    sequence: sample.sequence,
    mode: sample.isSimulated ? "DEMO" : "LIVE",
    peakSpectral: peakCh,
    spectrum: { ...sample.spectrum },
    ph: sample.ph !== null ? sample.ph.toFixed(2) : "—",
    humidity: sample.humidity !== null ? `${sample.humidity.toFixed(1)}%` : "—",
    drc: drcResult.drc !== null ? `${drcResult.drc.toFixed(1)}%` : "Uncalibrated",
    grade: qualityResult.displayTitle,
    validity: sample.isOverallValid ? "Valid" : "Partial"
  };

  STATE.history.unshift(record);
  if (STATE.history.length > CONFIG.historyLimit) {
    STATE.history.pop();
  }

  renderHistoryTable();
}

/**
 * Renders the in-memory history table.
 */
function renderHistoryTable() {
  DOM.historyRowCount.textContent = STATE.history.length;

  if (STATE.history.length === 0) {
    DOM.historyTableBody.innerHTML = `
      <tr class="empty-row" id="history-empty-row">
        <td colspan="9">No telemetry records logged yet. Start monitoring or switch to Demo Mode.</td>
      </tr>
    `;
    return;
  }

  DOM.historyTableBody.innerHTML = "";

  STATE.history.forEach(rec => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${rec.timestamp}</td>
      <td><strong>${rec.sampleId}</strong></td>
      <td><span class="mode-badge-cell ${rec.mode.toLowerCase()}">${rec.mode}</span></td>
      <td>${rec.peakSpectral}</td>
      <td>${rec.ph}</td>
      <td>${rec.humidity}</td>
      <td>${rec.drc}</td>
      <td><strong>${rec.grade}</strong></td>
      <td>${rec.validity}</td>
    `;
    DOM.historyTableBody.appendChild(tr);
  });
}

/**
 * Exports session telemetry history and full 14-channel spectral counts to CSV.
 */
function exportHistoryCsv() {
  if (STATE.history.length === 0) {
    alert("No telemetry records available to export. Start monitoring first.");
    return;
  }

  const headers = [
    "Timestamp_ISO",
    "Time_Local",
    "Sample_ID",
    "Sequence",
    "Acquisition_Mode",
    "pH",
    "Humidity_RH",
    "Estimated_DRC_Pct",
    "Quality_Grade",
    "Validity",
    ...SPECTRAL_CHANNELS.map(c => `AS7343_${c.code}_${c.wavelength.replace(/\s+/g, "")}`)
  ];

  const rows = STATE.history.map(rec => {
    const spectralCols = SPECTRAL_CHANNELS.map(c => {
      const v = rec.spectrum[c.id];
      return v !== null && v !== undefined ? v : "";
    });

    const fields = [
      rec.fullIso,
      rec.timestamp,
      rec.sampleId,
      rec.sequence !== null && rec.sequence !== undefined ? rec.sequence : "",
      rec.mode,
      rec.ph,
      rec.humidity.replace("%", ""),
      rec.drc.replace("%", ""),
      rec.grade,
      rec.validity,
      ...spectralCols
    ];

    return fields.map(val => `"${String(val).replace(/"/g, '""')}"`).join(",");
  });

  const csvContent = [headers.join(","), ...rows].join("\r\n");
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  const dateStamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  a.href = url;
  a.download = `LatexGuard-Telemetry-${dateStamp}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* ==========================================================================
   11. CONTROLS & EVENT WIRING
   ========================================================================== */

function startMonitoring() {
  if (STATE.isMonitoring) return;
  STATE.isMonitoring = true;

  DOM.btnStart.disabled = true;
  DOM.btnStop.disabled = false;

  // Execute immediately, then periodically (every 5000ms by default)
  fetchSensorTelemetry();
  STATE.pollingTimer = setInterval(fetchSensorTelemetry, CONFIG.pollingIntervalMs);
}

function stopMonitoring() {
  if (!STATE.isMonitoring) return;
  STATE.isMonitoring = false;

  DOM.btnStart.disabled = false;
  DOM.btnStop.disabled = true;

  if (STATE.pollingTimer) {
    clearInterval(STATE.pollingTimer);
    STATE.pollingTimer = null;
  }

  if (STATE.activeAbortController) {
    STATE.activeAbortController.abort();
    STATE.activeAbortController = null;
  }

  updateConnectionState("NOT CONNECTED");
}

function toggleMode() {
  // Stop existing polling loop and abort pending requests
  stopMonitoring();

  CONFIG.demoMode = !CONFIG.demoMode;

  if (CONFIG.demoMode) {
    DOM.modeStatusText.textContent = "DEMO MODE";
    DOM.modePill.className = "mode-pill mode-demo";
    DOM.btnToggleMode.textContent = "Switch to Live Mode";
    DOM.banner.className = "notification-banner";
    DOM.bannerText.textContent = "DEMO MODE ACTIVE: Displaying browser-simulated demonstration telemetry. ESP32 is NOT CONNECTED.";
    DOM.stripMode.textContent = "DEMO SIMULATION";
    DOM.stripMode.className = "strip-value";

    // MANDATORY: Demo Mode must always show ESP32 as NOT CONNECTED
    updateConnectionState("NOT CONNECTED");
  } else {
    DOM.modeStatusText.textContent = "LIVE SENSOR";
    DOM.modePill.className = "mode-pill mode-live";
    DOM.btnToggleMode.textContent = "Switch to Demo Mode";
    DOM.banner.className = "notification-banner banner-live";
    DOM.bannerText.textContent = `LIVE SENSOR MODE: Polling ESP32 REST server at ${CONFIG.sensorEndpoint}. Refreshing approximately every 5 seconds.`;
    DOM.stripMode.textContent = "LIVE SENSOR";
    DOM.stripMode.className = "strip-value highlight";

    // Initial state before request completes
    updateConnectionState("NOT CONNECTED");
  }

  // Automatically begin polling in the newly selected mode
  startMonitoring();
}

function reconnect() {
  stopMonitoring();
  startMonitoring();
}

function clearHistory() {
  STATE.history = [];
  renderHistoryTable();
}

function toggleSettingsDrawer() {
  const isHidden = DOM.settingsDrawer.hidden;
  DOM.settingsDrawer.hidden = !isHidden;
  DOM.btnToggleSettings.setAttribute("aria-expanded", String(isHidden));
}

function saveEndpoint() {
  const val = DOM.cfgEndpoint.value.trim();
  if (val.length > 0) {
    CONFIG.sensorEndpoint = val;
    DOM.commsEndpointDisplay.textContent = val;
    if (!CONFIG.demoMode) {
      DOM.bannerText.textContent = `LIVE SENSOR MODE: Polling ESP32 REST server at ${CONFIG.sensorEndpoint}. Refreshing approximately every 5 seconds.`;
    }
    alert(`ESP32 Endpoint updated to:\n${CONFIG.sensorEndpoint}`);
  }
}

function handleIntervalChange(e) {
  const val = parseInt(e.target.value, 10);
  if (!isNaN(val) && val >= 500 && val <= 30000) {
    CONFIG.pollingIntervalMs = val;
    if (STATE.isMonitoring) {
      clearInterval(STATE.pollingTimer);
      STATE.pollingTimer = setInterval(fetchSensorTelemetry, CONFIG.pollingIntervalMs);
    }
  }
}

function handleCalibrationToggle(e) {
  CONFIG.experimentalCalibrationEnabled = e.target.checked;
  // If we have current data, re-evaluate DRC immediately
  if (STATE.currentData) {
    const drcResult = estimateDRC(STATE.currentData, {
      enabled: CONFIG.experimentalCalibrationEnabled
    });
    const qualityResult = classifyLatexQuality(STATE.currentData, drcResult, GRADING_CONFIG);
    renderDrcPanel(drcResult);
    renderQualityPanel(qualityResult);
  }
}

/* ==========================================================================
   12. INITIALIZATION
   ========================================================================== */

function init() {
  // 1. Build initial scientific measurement grid for all 14 channels
  initSpectralGrid();

  // 2. Wire up all DOM listeners
  DOM.btnStart.addEventListener("click", startMonitoring);
  DOM.btnStop.addEventListener("click", stopMonitoring);
  DOM.btnReconnect.addEventListener("click", reconnect);
  DOM.btnToggleMode.addEventListener("click", toggleMode);
  DOM.btnClearHistory.addEventListener("click", clearHistory);
  DOM.btnExportCsv.addEventListener("click", exportHistoryCsv);
  DOM.btnToggleSettings.addEventListener("click", toggleSettingsDrawer);
  DOM.btnSaveEndpoint.addEventListener("click", saveEndpoint);
  DOM.cfgInterval.addEventListener("change", handleIntervalChange);
  DOM.cfgEnableCalibration.addEventListener("change", handleCalibrationToggle);

  // 3. Start background staleness checker (runs every 1 second)
  STATE.stalenessCheckerTimer = setInterval(checkStaleness, 1000);

  // 4. Set initial UI state based on CONFIG
  DOM.cfgEndpoint.value = CONFIG.sensorEndpoint;
  DOM.cfgInterval.value = CONFIG.pollingIntervalMs;
  DOM.commsEndpointDisplay.textContent = CONFIG.sensorEndpoint;

  if (CONFIG.demoMode) {
    DOM.modeStatusText.textContent = "DEMO MODE";
    DOM.modePill.className = "mode-pill mode-demo";
    DOM.btnToggleMode.textContent = "Switch to Live Mode";
    DOM.banner.className = "notification-banner";
    DOM.bannerText.textContent = "DEMO MODE ACTIVE: Displaying browser-simulated demonstration telemetry. ESP32 is NOT CONNECTED.";
    DOM.stripMode.textContent = "DEMO SIMULATION";
    DOM.stripMode.className = "strip-value";
    updateConnectionState("NOT CONNECTED");
  } else {
    DOM.modeStatusText.textContent = "LIVE SENSOR";
    DOM.modePill.className = "mode-pill mode-live";
    DOM.btnToggleMode.textContent = "Switch to Demo Mode";
    DOM.banner.className = "notification-banner banner-live";
    DOM.bannerText.textContent = `LIVE SENSOR MODE: Polling ESP32 REST server at ${CONFIG.sensorEndpoint}. Refreshing approximately every 5 seconds.`;
    DOM.stripMode.textContent = "LIVE SENSOR";
    DOM.stripMode.className = "strip-value highlight";
    updateConnectionState("NOT CONNECTED");
  }

  // 5. Start monitoring
  startMonitoring();
}

// Start application when DOM is ready
document.addEventListener("DOMContentLoaded", init);
