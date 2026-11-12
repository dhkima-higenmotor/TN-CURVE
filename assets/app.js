"use strict";

const DEFAULTS = Object.freeze({
  ratedTorque: 24,
  ratedSpeed: 3000,
  checkTorque: 12,
  checkSpeed: 3600,
  maxSpeed: 4200,
});

const FIELD_IDS = Object.keys(DEFAULTS);
const GEARBOX_DEFAULTS = Object.freeze({
  gearRatio: 10,
  gearEfficiency: 95,
});
const GEARBOX_FIELD_IDS = Object.keys(GEARBOX_DEFAULTS);
const ALL_FIELD_IDS = [...FIELD_IDS, ...GEARBOX_FIELD_IDS];
const EXPORT_WIDTH = 1800;
const EXPORT_HEIGHT = 1200;
const LOGICAL_EXPORT_WIDTH = 1000;
const LOGICAL_EXPORT_HEIGHT = 667;

const COLORS = Object.freeze({
  paper: "#fbfaf6",
  plot: "#f6f3eb",
  ink: "#191c18",
  inkSoft: "#3f443d",
  muted: "#898d82",
  grid: "#ded9cd",
  border: "#d8d2c5",
  accent: "#f15a37",
  accentDark: "#c84425",
  green: "#2a6b5b",
  max: "#687065",
  guide: "#85897e",
  fill300: "#e4e1d8",
  fill100: "#c4c1b8",
  warning: "#a26627",
});

const MONO = "'SFMono-Regular', 'Cascadia Mono', Consolas, 'Liberation Mono', monospace";

const refs = {
  form: document.querySelector("#curveForm"),
  resetButton: document.querySelector("#resetButton"),
  formMessage: document.querySelector("#formMessage"),
  equation: document.querySelector("#equation"),
  equationNote: document.querySelector("#equationNote"),
  plotSub: document.querySelector("#plotSub"),
  gearboxGroup: document.querySelector("#gearboxGroup"),
  basisNote: document.querySelector("#basisNote"),
  basisText: document.querySelector("#basisText"),
  driveModeInputs: [...document.querySelectorAll('input[name="driveMode"]')],
  chart: document.querySelector("#chart"),
  chartStage: document.querySelector("#chartStage"),
  chartTooltip: document.querySelector("#chartTooltip"),
  tooltipSpeed: document.querySelector("#tooltipSpeed"),
  tooltipTorque: document.querySelector("#tooltipTorque"),
  stallTorque: document.querySelector("#stallTorque"),
  zeroTorqueSpeed: document.querySelector("#zeroTorqueSpeed"),
  maxSpeedMetric: document.querySelector("#maxSpeedMetric"),
  slopeMetric: document.querySelector("#slopeMetric"),
  statusRow: document.querySelector("#statusRow"),
  statusText: document.querySelector("#statusText"),
  downloadButtons: [...document.querySelectorAll("[data-format]")],
  toast: document.querySelector("#toast"),
  year: document.querySelector("#year"),
};

const state = {
  analysis: null,
  chart: null,
  renderWidth: 0,
  busy: false,
};

const displayFormatters = {
  torque: new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 2,
  }),
  speed: new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 2,
  }),
};

let updateFrame = 0;
let resizeFrame = 0;
let toastTimer = 0;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function escapeXML(value) {
  return String(value).replace(/[<>&"']/g, (character) => {
    const entities = {
      "<": "&lt;",
      ">": "&gt;",
      "&": "&amp;",
      '"': "&quot;",
      "'": "&apos;",
    };
    return entities[character];
  });
}

function formatTorque(value) {
  if (!Number.isFinite(value)) return "—";
  return displayFormatters.torque.format(value).replace("-", "−");
}

function formatSpeed(value) {
  if (!Number.isFinite(value)) return "—";
  return displayFormatters.speed.format(value).replace("-", "−");
}

function formatPlain(value) {
  if (!Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value).replace("-", "−");
}

function coefficient(value) {
  if (!Number.isFinite(value)) return "—";
  if (value === 0) return "0";
  if (Math.abs(value) >= 100_000) return formatTorque(value);
  return value.toPrecision(4).replace("-", "−");
}

function formatAxisValue(value, step) {
  if (!Number.isFinite(value)) return "";
  const stepText = String(Number(step.toFixed(8)));
  const decimals = stepText.includes(".") ? Math.min(stepText.split(".")[1].length, 4) : 0;
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value);
}

function formatCompactAxisValue(value, step) {
  const absolute = Math.abs(value);
  if (absolute >= 1_000_000) {
    return `${Number((value / 1_000_000).toFixed(1))}M`;
  }
  if (absolute >= 1000) {
    const scaled = value / 1000;
    return `${Number(scaled.toFixed(Math.abs(scaled) < 10 ? 1 : 0))}k`;
  }
  return formatAxisValue(value, step);
}

function formatFileValue(value) {
  return Number.isInteger(value)
    ? String(value)
    : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function readFormValues() {
  const values = {};
  for (const id of FIELD_IDS) {
    const input = document.querySelector(`#${id}`);
    const raw = input.value.trim();
    values[id] = raw === "" ? Number.NaN : Number(raw);
  }

  const gearbox = {};
  for (const id of GEARBOX_FIELD_IDS) {
    const input = document.querySelector(`#${id}`);
    const raw = input.value.trim();
    gearbox[id] = raw === "" ? Number.NaN : Number(raw);
  }

  const checkedMode = document.querySelector('input[name="driveMode"]:checked')?.value;
  return {
    mode: checkedMode === "gearbox" ? "gearbox" : "motor",
    values,
    gearbox,
  };
}

function analyze(formValues) {
  const { mode, values: motorValues, gearbox } = formValues;
  const gearboxEnabled = mode === "gearbox";
  const errors = [];
  const warnings = [];
  const invalidFields = new Set();

  const missing = FIELD_IDS.filter((id) => !Number.isFinite(motorValues[id]));
  if (missing.length > 0) {
    missing.forEach((id) => invalidFields.add(id));
    errors.push("모든 모터 입력값을 숫자로 채워 주세요.");
  } else {
    const nonPositive = FIELD_IDS.filter((id) => motorValues[id] <= 0);
    if (nonPositive.length > 0) {
      nonPositive.forEach((id) => invalidFields.add(id));
      errors.push("모든 모터 값은 0보다 커야 합니다.");
    }
  }

  if (gearboxEnabled) {
    if (!Number.isFinite(gearbox.gearRatio)) {
      invalidFields.add("gearRatio");
      errors.push("감속비율을 숫자로 입력해 주세요.");
    } else if (gearbox.gearRatio < 1) {
      invalidFields.add("gearRatio");
      errors.push("감속비율은 1 이상이어야 합니다.");
    }

    if (!Number.isFinite(gearbox.gearEfficiency)) {
      invalidFields.add("gearEfficiency");
      errors.push("정격효율을 숫자로 입력해 주세요.");
    } else if (gearbox.gearEfficiency <= 0 || gearbox.gearEfficiency > 100) {
      invalidFields.add("gearEfficiency");
      errors.push("정격효율은 0% 초과 100% 이하로 입력해 주세요.");
    }
  }

  let slope = null;
  let intercept = null;
  let zeroTorqueSpeed = null;
  let threeSpeed = null;
  let threeIntersection = false;
  let outputValues = null;

  if (errors.length === 0) {
    const ratio = gearboxEnabled ? gearbox.gearRatio : 1;
    const efficiency = gearboxEnabled ? gearbox.gearEfficiency / 100 : 1;

    outputValues = {
      ratedTorque: motorValues.ratedTorque * ratio * efficiency,
      ratedSpeed: motorValues.ratedSpeed / ratio,
      checkTorque: motorValues.checkTorque * ratio * efficiency,
      checkSpeed: motorValues.checkSpeed / ratio,
      maxSpeed: motorValues.maxSpeed / ratio,
    };

    const {
      ratedTorque,
      ratedSpeed,
      checkTorque,
      checkSpeed,
      maxSpeed,
    } = outputValues;

    if (ratedSpeed === checkSpeed) {
      errors.push("Rated speed와 Check speed는 서로 달라야 합니다.");
      invalidFields.add("ratedSpeed");
      invalidFields.add("checkSpeed");
    } else {
      slope = (checkTorque - ratedTorque) / (checkSpeed - ratedSpeed);
      if (!Number.isFinite(slope) || slope >= 0) {
        errors.push("토크는 속도가 증가할수록 감소해야 합니다. 두 포인트의 방향을 확인하세요.");
        ["ratedTorque", "ratedSpeed", "checkTorque", "checkSpeed"].forEach((id) => invalidFields.add(id));
        slope = null;
      }
    }

    if (slope !== null) {
      intercept = ratedTorque - slope * ratedSpeed;
      zeroTorqueSpeed = -intercept / slope;

      if (!Number.isFinite(intercept) || !Number.isFinite(zeroTorqueSpeed) || intercept <= 0 || zeroTorqueSpeed <= 0) {
        errors.push("이 두 포인트로는 양의 축 절편을 만들 수 없습니다. 값을 다시 확인하세요.");
        ["ratedTorque", "ratedSpeed", "checkTorque", "checkSpeed"].forEach((id) => invalidFields.add(id));
        slope = null;
      }
    }

    if (errors.length === 0) {
      const threeTimesRated = ratedTorque * 3;
      const tolerance = Math.max(1e-9, Math.abs(threeTimesRated) * 1e-9);
      threeIntersection = intercept >= threeTimesRated - tolerance;
      if (threeIntersection) {
        threeSpeed = Math.max(0, (intercept - threeTimesRated) / -slope);
      } else {
        warnings.push("300% 정격 토크가 0 rpm 토크 절편보다 높아, 300% 가이드가 곡선과 만나지 않습니다.");
      }

      if (maxSpeed < Math.max(ratedSpeed, checkSpeed)) {
        warnings.push("Max speed가 운전점보다 낮습니다. 참조값을 확인하세요.");
      }

      if (threeSpeed !== null && threeSpeed < 1) {
        warnings.push("300% 가이드가 0 rpm 부근에서만 곡선과 닿습니다.");
      }
    }
  }

  const complete = errors.length === 0 && slope !== null;
  const aligned = complete
    ? Math.abs(outputValues.maxSpeed - zeroTorqueSpeed) <= Math.max(0.5, outputValues.maxSpeed * 0.005)
    : false;

  return {
    mode,
    gearboxEnabled,
    gearbox: gearboxEnabled
      ? { ratio: gearbox.gearRatio, efficiency: gearbox.gearEfficiency }
      : null,
    motorValues,
    values: outputValues || motorValues,
    errors,
    warnings,
    invalidFields,
    complete,
    slope,
    intercept,
    zeroTorqueSpeed,
    threeTimesRated: complete ? outputValues.ratedTorque * 3 : null,
    threeSpeed,
    threeIntersection,
    aligned,
  };
}

function scheduleUpdate() {
  if (updateFrame) cancelAnimationFrame(updateFrame);
  updateFrame = requestAnimationFrame(() => {
    updateFrame = 0;
    update();
  });
}

function syncDriveModeUI(mode) {
  const gearboxEnabled = mode === "gearbox";
  refs.gearboxGroup.hidden = !gearboxEnabled;
  refs.form.classList.toggle("has-gearbox", gearboxEnabled);
  refs.basisNote.classList.toggle("is-gearbox", gearboxEnabled);
  refs.basisText.textContent = gearboxEnabled
    ? "MOTOR INPUTS → GEARBOX OUTPUT"
    : "PLOT BASIS · MOTOR SHAFT";
}

function updatePlotContext(analysis) {
  if (analysis.complete && analysis.gearboxEnabled) {
    const ratio = formatPlain(analysis.gearbox.ratio);
    const efficiency = formatPlain(analysis.gearbox.efficiency);
    refs.plotSub.textContent = `Gearbox output · ${ratio}:1 reduction · η ${efficiency}% · axis-pinned`;
    return;
  }

  refs.plotSub.textContent = "Linear interpolation · motor shaft output · axis-pinned";
}

function update() {
  const formValues = readFormValues();
  syncDriveModeUI(formValues.mode);
  const analysis = analyze(formValues);
  state.analysis = analysis;

  ALL_FIELD_IDS.forEach((id) => {
    const input = document.querySelector(`#${id}`);
    const invalid = analysis.invalidFields.has(id);
    if (invalid) input.setAttribute("aria-invalid", "true");
    else input.removeAttribute("aria-invalid");
  });

  updateFormMessage(analysis);
  updateStatus(analysis);
  updatePlotContext(analysis);

  if (!analysis.complete) {
    state.chart = null;
    updateEquation(null);
    updateMetrics(analysis);
    renderChartError(analysis.errors[0] || "플롯을 그릴 수 없습니다.");
    setDownloadsEnabled(false);
    hideTooltip();
    return;
  }

  updateEquation(analysis);
  updateMetrics(analysis);
  setDownloadsEnabled(true);
  renderChart();
}

function updateFormMessage(analysis) {
  const messages = [...analysis.errors, ...analysis.warnings];
  if (messages.length === 0) {
    refs.formMessage.hidden = true;
    refs.formMessage.replaceChildren();
    refs.formMessage.classList.remove("is-warning");
    return;
  }

  const list = document.createElement("ul");
  messages.forEach((message) => {
    const item = document.createElement("li");
    item.textContent = message;
    list.append(item);
  });
  refs.formMessage.replaceChildren(list);
  refs.formMessage.hidden = false;
  refs.formMessage.classList.toggle("is-warning", analysis.errors.length === 0);
}

function updateStatus(analysis) {
  refs.statusRow.classList.remove("is-warning", "is-error");

  if (!analysis.complete) {
    refs.statusText.textContent = analysis.errors[0] || "입력값을 확인해 주세요.";
    refs.statusRow.classList.add("is-error");
    return;
  }

  if (analysis.warnings.length > 0) {
    refs.statusText.textContent = analysis.warnings[0];
    refs.statusRow.classList.add("is-warning");
    return;
  }

  if (analysis.aligned) {
    refs.statusText.textContent = `라인의 x절편이 Max speed ${formatSpeed(analysis.values.maxSpeed)} rpm과 일치합니다.`;
    return;
  }

  const delta = analysis.zeroTorqueSpeed - analysis.values.maxSpeed;
  const relation = delta > 0 ? "높습니다" : "낮습니다";
  refs.statusText.textContent = `라인의 x절편은 ${formatSpeed(analysis.zeroTorqueSpeed)} rpm으로, Max speed보다 ${formatSpeed(Math.abs(delta))} rpm ${relation}.`;
}

function updateEquation(analysis) {
  if (!analysis) {
    refs.equation.textContent = "—";
    refs.equationNote.textContent = "Rated + check define the straight line. T [Nm], N [rpm].";
    return;
  }

  const slopeMagnitude = coefficient(Math.abs(analysis.slope));
  refs.equation.textContent = `T = ${formatTorque(analysis.intercept)} − ${slopeMagnitude} × N`;

  if (analysis.gearboxEnabled) {
    refs.equationNote.textContent = `Output-shaft basis · N ÷ ${formatPlain(analysis.gearbox.ratio)} · T × ${formatPlain(analysis.gearbox.ratio)} × ${formatPlain(analysis.gearbox.efficiency)}%`;
  } else {
    refs.equationNote.textContent = "Rated + check define the straight line. T [Nm], N [rpm].";
  }
}

function updateMetrics(analysis) {
  if (!analysis.complete) {
    refs.stallTorque.innerHTML = "—";
    refs.zeroTorqueSpeed.innerHTML = "—";
    refs.maxSpeedMetric.innerHTML = `— <span>rpm</span>`;
    refs.slopeMetric.innerHTML = "—";
    return;
  }

  refs.stallTorque.innerHTML = `${formatTorque(analysis.intercept)} <span>Nm</span>`;
  refs.zeroTorqueSpeed.innerHTML = `${formatSpeed(analysis.zeroTorqueSpeed)} <span>rpm</span>`;
  refs.maxSpeedMetric.innerHTML = `${formatSpeed(analysis.values.maxSpeed)} <span>rpm</span>`;
  refs.slopeMetric.innerHTML = `${formatTorque(analysis.slope * 1000)} <span>Nm</span>`;
  refs.maxSpeedMetric.setAttribute(
    "title",
    analysis.gearboxEnabled
      ? "Max speed at no load, converted to the gearbox output shaft"
      : "Max speed at no load — reference from the motor-shaft input",
  );
}

function renderChartError(message) {
  hideTooltip();
  refs.chart.innerHTML = `
    <div class="chart-empty" role="img" aria-label="플롯을 표시할 수 없습니다">
      <div class="chart-empty-mark" aria-hidden="true">
        <svg viewBox="0 0 64 64" width="64" height="64" fill="none">
          <path d="M9 9v46h46" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          <path d="M9 45 24 31l9 6L54 18" stroke="currentColor" stroke-width="1.4" stroke-dasharray="4 5" stroke-linecap="round" opacity=".45"/>
          <circle cx="55" cy="55" r="8" fill="#fbfaf6" stroke="currentColor" stroke-width="1.5"/>
          <path d="M55 50v6M55 59v.2" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
        </svg>
      </div>
      <p class="chart-empty-kicker">PLOT UNAVAILABLE</p>
      <strong>입력값을 조정해 주세요.</strong>
      <p class="chart-empty-message"></p>
    </div>`;
  refs.chart.querySelector(".chart-empty-message").textContent = message;
}

function renderChart() {
  if (!state.analysis?.complete) return;

  const width = Math.round(refs.chart.clientWidth || refs.chartStage.clientWidth || 900);
  if (width < 80) return;

  const compact = width < 760;
  const height = Math.round(clamp(width * 0.72, compact ? 460 : 580, 700));
  state.renderWidth = width;
  state.chart = buildChart(state.analysis, {
    width,
    height,
    compact,
    pixelWidth: width,
    pixelHeight: height,
  });
  refs.chart.innerHTML = state.chart.svg;
  state.chart.svgElement = refs.chart.querySelector("svg");
  hideTooltip();
}

function niceStep(range, targetTicks) {
  const raw = range / Math.max(1, targetTicks);
  const power = Math.floor(Math.log10(raw));
  const fraction = raw / 10 ** power;
  let niceFraction;
  if (fraction <= 1) niceFraction = 1;
  else if (fraction <= 2) niceFraction = 2;
  else if (fraction <= 2.5) niceFraction = 2.5;
  else if (fraction <= 5) niceFraction = 5;
  else niceFraction = 10;
  return niceFraction * 10 ** power;
}

function makeTicks(max, targetTicks) {
  const step = niceStep(max, targetTicks);
  const ticks = [];
  const epsilon = step * 1e-8;
  for (let index = 0; index <= Math.ceil(max / step + epsilon); index += 1) {
    const value = Number((index * step).toPrecision(12));
    if (value > max + epsilon) break;
    ticks.push({ value, step });
  }
  return ticks;
}

function buildChart(analysis, options) {
  const {
    width,
    height,
    compact = false,
    pixelWidth = width,
    pixelHeight = height,
    exportMode = false,
  } = options;

  const mini = width < 420;
  const ui = width < 760 ? 0.94 : clamp(width / 900, 1, 1.12);
  const margins = {
    left: compact ? 70 : 100,
    right: compact ? 18 : 38,
    top: compact ? 68 : 82,
    bottom: compact ? 82 : 90,
  };
  const plotLeft = margins.left;
  const plotTop = margins.top;
  const plotRight = width - margins.right;
  const plotBottom = height - margins.bottom;
  const plotWidth = plotRight - plotLeft;
  const plotHeight = plotBottom - plotTop;

  const font = {
    tick: 19.5 * ui,
    axisTitle: 17 * ui,
    meta: 13.5 * ui,
    guide: 15 * ui,
    max: 15.5 * ui,
    pointTitle: 14 * ui,
    pointValue: 18 * ui,
    pointCompact: 16 * ui,
    watermark: 12 * ui,
  };

  const { values, intercept, slope, zeroTorqueSpeed, threeTimesRated, threeSpeed } = analysis;
  const t3 = threeTimesRated;
  const xMax = Math.max(zeroTorqueSpeed, values.maxSpeed, values.ratedSpeed, values.checkSpeed) * 1.045;
  const yMax = Math.max(intercept, t3, values.ratedTorque * 1.2) * 1.075;
  const xTickData = makeTicks(xMax, compact ? (width < 420 ? 4 : 5) : 6);
  const yTickData = makeTicks(yMax, 5);

  const mapX = (value) => plotLeft + (value / xMax) * plotWidth;
  const mapY = (value) => plotTop + (1 - value / yMax) * plotHeight;

  const ratedX = mapX(values.ratedSpeed);
  const ratedY = mapY(values.ratedTorque);
  const checkX = mapX(values.checkSpeed);
  const checkY = mapY(values.checkTorque);
  const ratedGuideX = mapX(values.ratedSpeed);
  const ratedGuideY = mapY(values.ratedTorque);
  const threeGuideY = mapY(t3);
  const threeGuideX = threeSpeed !== null ? mapX(Math.max(0, threeSpeed)) : null;
  const maxX = mapX(values.maxSpeed);

  const pointLabels = [];
  const ratedTorqueLabel = `${formatTorque(values.ratedTorque)} Nm`;
  const ratedSpeedLabel = `${formatSpeed(values.ratedSpeed)} rpm`;
  const checkTorqueLabel = `${formatTorque(values.checkTorque)} Nm`;
  const checkSpeedLabel = `${formatSpeed(values.checkSpeed)} rpm`;
  const pointPlot = { left: plotLeft, right: plotRight, top: plotTop, bottom: plotBottom };
  const ratedLabel = mini
    ? miniPointLabel({
        x: ratedX,
        y: ratedY,
        title: "RATED",
        color: COLORS.accent,
        font,
        plot: pointPlot,
        preferred: "above",
      })
    : placePointLabel({
        x: ratedX,
        y: ratedY,
        title: "RATED",
        torqueLabel: ratedTorqueLabel,
        speedLabel: ratedSpeedLabel,
        color: COLORS.accent,
        compact,
        font,
        plot: pointPlot,
        preferred: "above",
        otherBoxes: [],
      });
  pointLabels.push(ratedLabel);

  const checkLabel = mini
    ? miniPointLabel({
        x: checkX,
        y: checkY,
        title: "CHECK",
        color: COLORS.green,
        font,
        plot: pointPlot,
        preferred: "below",
      })
    : placePointLabel({
        x: checkX,
        y: checkY,
        title: "CHECK",
        torqueLabel: checkTorqueLabel,
        speedLabel: checkSpeedLabel,
        color: COLORS.green,
        compact,
        font,
        plot: pointPlot,
        preferred: "below",
        otherBoxes: [ratedLabel.box],
        leftAtEdge: true,
      });
  pointLabels.push(checkLabel);

  const fills = [];
  if (threeGuideX !== null) {
    fills.push(
      `<path d="M ${plotLeft} ${plotBottom} L ${threeGuideX} ${plotBottom} L ${threeGuideX} ${threeGuideY} L ${plotLeft} ${threeGuideY} Z" fill="${COLORS.fill300}" />`,
    );
  }
  fills.push(
    `<path d="M ${plotLeft} ${plotBottom} L ${ratedGuideX} ${plotBottom} L ${ratedGuideX} ${ratedGuideY} L ${plotLeft} ${ratedGuideY} Z" fill="${COLORS.fill100}" />`,
  );

  const verticalGrid = xTickData
    .filter((tick) => tick.value > 0)
    .map(
      (tick) =>
        `<line x1="${mapX(tick.value)}" y1="${plotTop}" x2="${mapX(tick.value)}" y2="${plotBottom}" stroke="${COLORS.grid}" stroke-width="1" opacity=".7" />`,
    )
    .join("");

  const horizontalGrid = yTickData
    .filter((tick) => tick.value > 0)
    .map(
      (tick) =>
        `<line x1="${plotLeft}" y1="${mapY(tick.value)}" x2="${plotRight}" y2="${mapY(tick.value)}" stroke="${COLORS.grid}" stroke-width="1" opacity=".7" />`,
    )
    .join("");

  const xTickLabels = xTickData
    .map((tick) => {
      const x = mapX(tick.value);
      const tickLabel = compact
        ? formatCompactAxisValue(tick.value, tick.step)
        : formatAxisValue(tick.value, tick.step);
      return `
        <line x1="${x}" y1="${plotBottom}" x2="${x}" y2="${plotBottom + 5}" stroke="${COLORS.inkSoft}" stroke-width="1.2" />
        <text x="${x}" y="${plotBottom + (compact ? 25 : 28)}" text-anchor="middle" class="chart-tick">${tickLabel}</text>`;
    })
    .join("");

  const yTickLabels = yTickData
    .map((tick) => {
      const y = mapY(tick.value);
      return `
        <line x1="${plotLeft - 5}" y1="${y}" x2="${plotLeft}" y2="${y}" stroke="${COLORS.inkSoft}" stroke-width="1.2" />
        ${tick.value > 0 ? `<text x="${plotLeft - (compact ? 10 : 13)}" y="${y + font.tick * 0.34}" text-anchor="end" class="chart-tick">${formatAxisValue(tick.value, tick.step)}</text>` : ""}`;
    })
    .join("");

  const guideLabels = [];
  if (threeGuideX !== null) {
    const text = mini
      ? "300%"
      : compact
        ? `300% · ${formatTorque(t3)} Nm`
        : `300% RATED · ${formatTorque(t3)} Nm`;
    guideLabels.push(
      guideLabel({
        text,
        x: plotLeft + 6,
        y: threeGuideY,
        font,
        color: COLORS.guide,
        topBoundary: plotTop + 4,
      }),
    );
  } else {
    guideLabels.push(`
      <line x1="${plotLeft}" y1="${threeGuideY}" x2="${plotRight}" y2="${threeGuideY}" stroke="${COLORS.warning}" stroke-width="1.5" stroke-dasharray="3 7" stroke-linecap="round" opacity=".8" />
      ${guideLabel({
        text: compact ? "300% · ABOVE CURVE" : "300% RATED · ABOVE CURVE",
        x: plotLeft + 6,
        y: threeGuideY,
        font,
        color: COLORS.warning,
        topBoundary: plotTop + 4,
      })}
    `);
  }

  const ratedGuideText = mini
    ? "100%"
    : compact
      ? `100% · ${formatTorque(values.ratedTorque)} Nm`
      : `100% RATED · ${formatTorque(values.ratedTorque)} Nm`;
  guideLabels.push(
    guideLabel({
      text: ratedGuideText,
      x: plotLeft + 6,
      y: ratedGuideY,
      font,
      color: COLORS.inkSoft,
      topBoundary: plotTop + 4,
    }),
  );

  const maxLabel = compact
    ? `MAX · ${formatSpeed(values.maxSpeed)} rpm`
    : `MAX SPEED @ NO LOAD · ${formatSpeed(values.maxSpeed)} rpm`;
  const maxLabelAnchor = maxX > plotLeft + plotWidth * 0.62 ? "end" : "start";
  const maxLabelX = maxX + (maxLabelAnchor === "end" ? -6 : 6);
  const maxLabelY = plotTop - 12;

  const pointMarkup = pointLabels
    .map((label) => {
      const { box, point } = label;
      if (!box) return label.svg;
      const leader = `<line x1="${point.x}" y1="${point.y}" x2="${clamp(point.x, box.x, box.x + box.width)}" y2="${clamp(point.y, box.y, box.y + box.height)}" stroke="${label.color}" stroke-width="1.2" opacity=".42" />`;
      return `${leader}${label.svg}`;
    })
    .join("");

  const watermark = exportMode
    ? `<text x="${plotRight}" y="${height - 10}" text-anchor="end" class="chart-watermark">TN CURVE STUDIO · STATIC / SERVERLESS · ${new Date().getFullYear()}</text>`
    : "";

  const gearboxMeta = analysis.gearboxEnabled
    ? `GEARBOX ${formatPlain(analysis.gearbox.ratio)}:1 · η ${formatPlain(analysis.gearbox.efficiency)}%`
    : null;
  const basisTitle = analysis.gearboxEnabled ? "Gearbox output — " : "Motor shaft — ";
  const title = `${basisTitle}TN Curve — ${formatTorque(values.ratedTorque)} Nm @ ${formatSpeed(values.ratedSpeed)} rpm to ${formatTorque(values.checkTorque)} Nm @ ${formatSpeed(values.checkSpeed)} rpm`;
  const basisDescription = analysis.gearboxEnabled
    ? ` Gearbox output basis. Reduction ratio ${formatPlain(analysis.gearbox.ratio)} to 1; rated efficiency ${formatPlain(analysis.gearbox.efficiency)} percent.`
    : " Motor shaft basis.";
  const description = `Torque-speed curve. Stall torque ${formatTorque(intercept)} Nm at 0 rpm; zero-torque speed ${formatSpeed(zeroTorqueSpeed)} rpm. Rated torque guide ${formatTorque(values.ratedTorque)} Nm; 300 percent guide ${formatTorque(t3)} Nm. Max speed at no load ${formatSpeed(values.maxSpeed)} rpm.${basisDescription}`;
  const metaLeft = exportMode ? "TN CURVE / TORQUE–SPEED ENVELOPE" : "TN CURVE / FIG. 01";
  const metaRight = analysis.gearboxEnabled
    ? `OUTPUT SHAFT · ${gearboxMeta}`
    : exportMode
      ? "MOTOR SHAFT · AXIS-PINNED"
      : "MOTOR SHAFT · LINEAR";

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${pixelWidth}" height="${pixelHeight}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="tnCurveTitle tnCurveDesc">
    <title id="tnCurveTitle">${escapeXML(title)}</title>
    <desc id="tnCurveDesc">${escapeXML(description)}</desc>
    <style>
      .chart-meta { font-family: ${MONO}; font-size: ${font.meta}px; font-weight: 600; fill: ${COLORS.muted}; letter-spacing: .085em; }
      .chart-meta-accent { fill: ${COLORS.inkSoft}; }
      .chart-tick { font-family: ${MONO}; font-size: ${font.tick}px; fill: ${COLORS.muted}; font-variant-numeric: tabular-nums; }
      .chart-axis-title { font-family: ${MONO}; font-size: ${font.axisTitle}px; fill: ${COLORS.inkSoft}; font-weight: 600; letter-spacing: .12em; }
      .chart-guide-label { font-family: ${MONO}; font-size: ${font.guide}px; font-weight: 600; letter-spacing: .015em; }
      .chart-max-label { font-family: ${MONO}; font-size: ${font.max}px; font-weight: 600; fill: ${COLORS.max}; letter-spacing: .035em; }
      .chart-point-title { font-family: ${MONO}; font-size: ${font.pointTitle}px; font-weight: 700; letter-spacing: .09em; }
      .chart-point-value { font-family: ${MONO}; font-size: ${font.pointValue}px; font-weight: 600; fill: ${COLORS.ink}; font-variant-numeric: tabular-nums; }
      .chart-point-compact { font-family: ${MONO}; font-size: ${font.pointCompact}px; font-weight: 700; letter-spacing: .03em; }
      .chart-point-mini { font-family: ${MONO}; font-size: ${font.pointTitle}px; font-weight: 700; letter-spacing: .06em; paint-order: stroke; }
      .chart-watermark { font-family: ${MONO}; font-size: ${font.watermark}px; fill: ${COLORS.muted}; letter-spacing: .06em; }
      .chart-hit { cursor: crosshair; }
    </style>
    <rect width="${width}" height="${height}" fill="${COLORS.paper}" />
    <rect x="${plotLeft}" y="${plotTop}" width="${plotWidth}" height="${plotHeight}" rx="1" fill="${COLORS.plot}" stroke="${COLORS.border}" stroke-width="1.1" />
    <g aria-hidden="true">${fills.join("")}</g>
    <g aria-hidden="true">${verticalGrid}${horizontalGrid}</g>
    <line x1="${plotLeft}" y1="${threeGuideY}" x2="${threeGuideX ?? plotRight}" y2="${threeGuideY}" stroke="${COLORS.guide}" stroke-width="1.5" stroke-dasharray="3 7" stroke-linecap="round" opacity="${threeGuideX !== null ? ".95" : "0"}" />
    <line x1="${plotLeft}" y1="${ratedGuideY}" x2="${ratedGuideX}" y2="${ratedGuideY}" stroke="${COLORS.inkSoft}" stroke-width="1.5" stroke-dasharray="3 7" stroke-linecap="round" />
    ${threeGuideX !== null ? `<circle cx="${threeGuideX}" cy="${threeGuideY}" r="3" fill="${COLORS.paper}" stroke="${COLORS.guide}" stroke-width="1.2" />` : ""}
    <circle cx="${ratedGuideX}" cy="${ratedGuideY}" r="3" fill="${COLORS.paper}" stroke="${COLORS.inkSoft}" stroke-width="1.2" />
    <g aria-hidden="true">
      <line x1="${maxX}" y1="${plotTop}" x2="${maxX}" y2="${plotBottom}" stroke="${COLORS.max}" stroke-width="1.4" stroke-dasharray="4 8" opacity=".85" />
      <circle cx="${maxX}" cy="${plotTop}" r="3.5" fill="${COLORS.paper}" stroke="${COLORS.max}" stroke-width="1.3" />
      <text x="${maxLabelX}" y="${maxLabelY}" text-anchor="${maxLabelAnchor}" class="chart-max-label">${escapeXML(maxLabel)}</text>
    </g>
    <g aria-hidden="true">
      <line x1="${plotLeft}" y1="${mapY(intercept)}" x2="${plotRight}" y2="${mapY(intercept)}" stroke="${COLORS.paper}" stroke-width="0" />
      <line x1="${plotLeft}" y1="${mapY(intercept)}" x2="${mapX(zeroTorqueSpeed)}" y2="${mapY(0)}" stroke="${COLORS.paper}" stroke-width="9.5" opacity=".85" stroke-linecap="round" />
      <line x1="${plotLeft}" y1="${mapY(intercept)}" x2="${mapX(zeroTorqueSpeed)}" y2="${mapY(0)}" stroke="${COLORS.ink}" stroke-width="3.4" stroke-linecap="round" />
    </g>
    <g aria-hidden="true">
      <circle cx="${plotLeft}" cy="${mapY(intercept)}" r="4.2" fill="${COLORS.paper}" stroke="${COLORS.ink}" stroke-width="1.7" />
      <circle cx="${mapX(zeroTorqueSpeed)}" cy="${plotBottom}" r="4.2" fill="${COLORS.paper}" stroke="${COLORS.ink}" stroke-width="1.7" />
    </g>
    <g class="plot-axis" aria-hidden="true">
      <line x1="${plotLeft}" y1="${plotTop}" x2="${plotLeft}" y2="${plotBottom}" stroke="${COLORS.inkSoft}" stroke-width="1.5" />
      <line x1="${plotLeft}" y1="${plotBottom}" x2="${plotRight}" y2="${plotBottom}" stroke="${COLORS.inkSoft}" stroke-width="1.5" />
      ${xTickLabels}
      ${yTickLabels}
      <text x="${plotLeft + plotWidth / 2}" y="${plotBottom + (compact ? 58 : 63)}" text-anchor="middle" class="chart-axis-title">SPEED [rpm]</text>
      <text x="${compact ? 17 : 21}" y="${plotTop + plotHeight / 2}" text-anchor="middle" class="chart-axis-title" transform="rotate(-90 ${compact ? 17 : 21} ${plotTop + plotHeight / 2})">TORQUE [Nm]</text>
    </g>
    ${compact ? "" : `<g aria-hidden="true">
      <circle cx="${plotLeft + 4}" cy="24" r="3.6" fill="${COLORS.accent}" />
      <text x="${plotLeft + 14}" y="28" class="chart-meta chart-meta-accent">${metaLeft}</text>
      <text x="${plotRight}" y="28" text-anchor="end" class="chart-meta">${metaRight}</text>
    </g>`}
    <g aria-hidden="true">${guideLabels.join("")}</g>
    <g aria-hidden="true">
      <circle cx="${ratedX}" cy="${ratedY}" r="8.2" fill="${COLORS.paper}" stroke="${COLORS.accent}" stroke-width="2.8" />
      <circle cx="${ratedX}" cy="${ratedY}" r="2.8" fill="${COLORS.accent}" />
      <circle cx="${checkX}" cy="${checkY}" r="8.2" fill="${COLORS.paper}" stroke="${COLORS.green}" stroke-width="2.8" />
      <circle cx="${checkX}" cy="${checkY}" r="2.8" fill="${COLORS.green}" />
    </g>
    ${pointMarkup}
    ${watermark}
    <g class="hover-layer" opacity="0" pointer-events="none" aria-hidden="true">
      <line class="hover-line" x1="${plotLeft}" y1="${plotTop}" x2="${plotLeft}" y2="${plotBottom}" stroke="${COLORS.accent}" stroke-width="1.3" stroke-dasharray="4 5" opacity=".65" />
      <circle class="hover-dot" cx="${plotLeft}" cy="${plotBottom}" r="5.5" fill="${COLORS.paper}" stroke="${COLORS.accent}" stroke-width="2.5" />
    </g>
    <rect class="chart-hit" x="${plotLeft}" y="${plotTop}" width="${plotWidth}" height="${plotHeight}" fill="transparent" aria-label="플롯 위에서 속도와 토크를 확인하세요" />
  </svg>`;

  return {
    svg,
    width,
    height,
    geometry: {
      width,
      height,
      plotLeft,
      plotTop,
      plotRight,
      plotBottom,
      plotWidth,
      plotHeight,
      xMax,
      yMax,
      intercept,
      slope,
      zeroTorqueSpeed,
    },
  };
}

function guideLabel({ text, x, y, font, color, topBoundary = 52 }) {
  const width = text.length * font.guide * 0.62 + 18;
  const height = font.guide + 12;
  let topValue = y - height - 7;
  if (topValue < topBoundary) topValue = y + 7;
  return `
    <g>
      <rect x="${x}" y="${topValue}" width="${width}" height="${height}" rx="4" fill="${COLORS.plot}" opacity=".94" />
      <text x="${x + 8}" y="${topValue + height - 6}" class="chart-guide-label" fill="${color}">${escapeXML(text)}</text>
    </g>`;
}

function miniPointLabel({ x, y, title, color, font, plot, preferred }) {
  const width = title.length * font.pointTitle * 0.7 + 12;
  const gap = 12;
  let textX;
  let anchor;
  let textY;

  if (preferred === "above") {
    if (x + gap + width <= plot.right - 4) {
      textX = x + gap;
      anchor = "start";
    } else {
      textX = x - gap;
      anchor = "end";
    }
    textY = y - 12;
  } else if (x - gap - width >= plot.left + 4) {
    textX = x - gap;
    anchor = "end";
    textY = y + font.pointTitle + 14;
  } else {
    textX = x + gap;
    anchor = "start";
    textY = y + font.pointTitle + 14;
  }

  const svg = `
    <text x="${textX}" y="${textY}" text-anchor="${anchor}" class="chart-point-mini" fill="${color}" stroke="${COLORS.paper}" stroke-width="4.5" stroke-linejoin="round">${escapeXML(title)}</text>`;

  return {
    box: null,
    point: { x, y },
    color,
    svg,
  };
}

function placePointLabel({ x, y, title, torqueLabel, speedLabel, color, compact, font, plot, preferred, otherBoxes, leftAtEdge = false }) {
  const plotWidth = plot.right - plot.left;
  const shortLabel = compact && plotWidth < 400;
  const compactText = shortLabel ? title : `${title} · ${torqueLabel}`;
  const titleText = `${title} · ${speedLabel}`;
  const width = compact
    ? Math.max(92, compactText.length * font.pointCompact * 0.65 + 28)
    : Math.max(
        190,
        titleText.length * font.pointTitle * 0.68 + 34,
        torqueLabel.length * font.pointValue * 0.6 + 34,
      );
  const height = compact
    ? font.pointCompact + 22
    : font.pointTitle + font.pointValue + 20;
  const gap = compact ? 12 : 8;
  const useLeft = leftAtEdge
    && x + gap + width > plot.right - 12
    && x - width - gap >= plot.left + 8;
  const horizontalOrder = useLeft ? ["left", "right"] : ["right", "left"];
  const verticalOrder = preferred === "above" ? ["above", "below"] : ["below", "above"];
  const candidates = [];

  verticalOrder.forEach((vertical) => {
    horizontalOrder.forEach((horizontal) => {
      candidates.push({
        x: horizontal === "left" ? x - width - gap : x + gap,
        y: vertical === "above" ? y - height - gap : y + gap,
      });
    });
  });

  const padding = compact ? 7 : 10;
  const candidatesWithBounds = candidates.map((candidate) => ({
    x: clamp(candidate.x, plot.left + padding, plot.right - width - padding),
    y: candidate.y,
    fitsVertically: candidate.y >= plot.top + padding
      && candidate.y + height <= plot.bottom - 0.5,
  }));

  let chosen = null;
  for (const candidate of candidatesWithBounds) {
    if (!candidate.fitsVertically) continue;
    const intersects = otherBoxes.some((box) => rectanglesIntersect(
      { x: candidate.x, y: candidate.y, width, height },
      { x: box.x, y: box.y, width: box.width, height: box.height },
      6,
    ));
    if (!intersects) {
      chosen = candidate;
      break;
    }
  }

  if (!chosen) {
    const fallback = candidatesWithBounds.find((candidate) => candidate.fitsVertically)
      || candidatesWithBounds[0];
    chosen = {
      x: fallback.x,
      y: clamp(fallback.y, plot.top + padding, plot.bottom - height - 0.5),
    };
  }

  const box = { x: chosen.x, y: chosen.y, width, height };
  const svg = compact
    ? `
      <g>
        <rect x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" rx="8" fill="${COLORS.paper}" stroke="${color}" stroke-width="1.2" opacity=".97" />
        <rect x="${box.x}" y="${box.y}" width="4" height="${box.height}" rx="2" fill="${color}" />
        <text x="${box.x + 13}" y="${box.y + box.height / 2 + font.pointCompact * 0.34}" class="chart-point-compact" fill="${color}">${escapeXML(compactText)}</text>
      </g>`
    : `
      <g>
        <rect x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" rx="9" fill="${COLORS.paper}" stroke="${COLORS.border}" stroke-width="1.2" opacity=".98" />
        <rect x="${box.x}" y="${box.y}" width="4" height="${box.height}" rx="2" fill="${color}" />
        <text x="${box.x + 16}" y="${box.y + font.pointTitle + 6}" class="chart-point-title" fill="${color}">${escapeXML(titleText)}</text>
        <text x="${box.x + 16}" y="${box.y + font.pointTitle + font.pointValue + 14}" class="chart-point-value">${escapeXML(torqueLabel)}</text>
      </g>`;

  return {
    box,
    point: { x, y },
    color,
    svg,
  };
}

function rectanglesIntersect(a, b, padding = 0) {
  return !(
    a.x + a.width + padding <= b.x ||
    b.x + b.width + padding <= a.x ||
    a.y + a.height + padding <= b.y ||
    b.y + b.height + padding <= a.y
  );
}

function setDownloadsEnabled(enabled) {
  refs.downloadButtons.forEach((button) => {
    button.disabled = !enabled || state.busy;
    button.setAttribute("aria-disabled", String(!enabled || state.busy));
  });
}

function currentFileBase() {
  const analysis = state.analysis;
  const values = analysis.values;
  const gearbox = analysis.gearboxEnabled
    ? `_gear${formatFileValue(analysis.gearbox.ratio)}x-${formatFileValue(analysis.gearbox.efficiency)}eff`
    : "";
  return `tn-curve${gearbox}_${formatFileValue(values.ratedTorque)}Nm-${formatFileValue(values.ratedSpeed)}rpm`;
}

function exportSvgMarkup() {
  return buildChart(state.analysis, {
    width: LOGICAL_EXPORT_WIDTH,
    height: LOGICAL_EXPORT_HEIGHT,
    compact: false,
    pixelWidth: EXPORT_WIDTH,
    pixelHeight: EXPORT_HEIGHT,
    exportMode: true,
  }).svg;
}

async function downloadPlot(format, button) {
  if (!state.analysis?.complete || state.busy) return;

  state.busy = true;
  setDownloadsEnabled(false);
  button.classList.add("is-busy");
  button.setAttribute("aria-busy", "true");
  hideTooltip();

  try {
    const svgMarkup = exportSvgMarkup();
    const baseName = currentFileBase();

    if (format === "svg") {
      const blob = new Blob([`<?xml version="1.0" encoding="UTF-8"?>\n${svgMarkup}`], {
        type: "image/svg+xml;charset=utf-8",
      });
      triggerDownload(blob, `${baseName}.svg`);
      showToast("SVG 플롯을 다운로드했습니다.");
    } else {
      const blob = await svgToPngBlob(svgMarkup);
      triggerDownload(blob, `${baseName}.png`);
      showToast("PNG 플롯을 다운로드했습니다.");
    }
  } catch (error) {
    console.error(error);
    showToast("플롯 파일을 만들지 못했습니다. 다시 시도해 주세요.", true);
  } finally {
    state.busy = false;
    button.classList.remove("is-busy");
    button.removeAttribute("aria-busy");
    setDownloadsEnabled(Boolean(state.analysis?.complete));
  }
}

function svgToPngBlob(svgMarkup) {
  return new Promise((resolve, reject) => {
    const svgBlob = new Blob([svgMarkup], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(svgBlob);
    const image = new Image();

    image.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = EXPORT_WIDTH;
        canvas.height = EXPORT_HEIGHT;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Canvas is unavailable");
        context.fillStyle = COLORS.paper;
        context.fillRect(0, 0, EXPORT_WIDTH, EXPORT_HEIGHT);
        context.drawImage(image, 0, 0, EXPORT_WIDTH, EXPORT_HEIGHT);
        canvas.toBlob((blob) => {
          URL.revokeObjectURL(url);
          if (blob) resolve(blob);
          else reject(new Error("PNG encoding failed"));
        }, "image/png");
      } catch (error) {
        URL.revokeObjectURL(url);
        reject(error);
      }
    };

    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("SVG rendering failed"));
    };

    image.src = url;
  });
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function showToast(message, isError = false) {
  window.clearTimeout(toastTimer);
  refs.toast.textContent = message;
  refs.toast.classList.toggle("is-error", isError);
  refs.toast.classList.add("is-visible");
  toastTimer = window.setTimeout(() => {
    refs.toast.classList.remove("is-visible");
  }, 2800);
}

function hideTooltip() {
  refs.chartTooltip.hidden = true;
  refs.chartTooltip.classList.remove("is-below");
  const hoverLayer = refs.chart.querySelector(".hover-layer");
  if (hoverLayer) hoverLayer.setAttribute("opacity", "0");
}

function handlePointerMove(event) {
  if (!state.analysis?.complete || !state.chart?.svgElement) return;
  const svg = state.chart.svgElement;
  const geometry = state.chart.geometry;
  const svgRect = svg.getBoundingClientRect();
  if (svgRect.width === 0 || svgRect.height === 0) return;

  const x = (event.clientX - svgRect.left) * (geometry.width / svgRect.width);
  const y = (event.clientY - svgRect.top) * (geometry.height / svgRect.height);

  if (x < geometry.plotLeft || x > geometry.plotRight || y < geometry.plotTop || y > geometry.plotBottom) {
    hideTooltip();
    return;
  }

  const speed = ((x - geometry.plotLeft) / geometry.plotWidth) * geometry.xMax;
  if (speed < 0 || speed > geometry.zeroTorqueSpeed) {
    hideTooltip();
    return;
  }

  const torque = Math.max(0, geometry.intercept + geometry.slope * speed);
  const curveY = geometry.plotTop + (1 - torque / geometry.yMax) * geometry.plotHeight;

  const hoverLayer = svg.querySelector(".hover-layer");
  const hoverLine = svg.querySelector(".hover-line");
  const hoverDot = svg.querySelector(".hover-dot");
  if (!hoverLayer || !hoverLine || !hoverDot) return;

  hoverLayer.setAttribute("opacity", "1");
  hoverLine.setAttribute("x1", String(x));
  hoverLine.setAttribute("x2", String(x));
  hoverLine.setAttribute("y1", String(geometry.plotTop));
  hoverLine.setAttribute("y2", String(geometry.plotBottom));
  hoverDot.setAttribute("cx", String(x));
  hoverDot.setAttribute("cy", String(curveY));

  refs.tooltipSpeed.textContent = `${formatSpeed(speed)} rpm`;
  refs.tooltipTorque.textContent = `${formatTorque(torque)} Nm`;

  const stageRect = refs.chartStage.getBoundingClientRect();
  const dotX = svgRect.left - stageRect.left + x * (svgRect.width / geometry.width);
  const dotY = svgRect.top - stageRect.top + curveY * (svgRect.height / geometry.height);

  refs.chartTooltip.hidden = false;
  refs.chartTooltip.style.left = "0px";
  refs.chartTooltip.style.top = "0px";
  const tooltipWidth = refs.chartTooltip.offsetWidth;
  const tooltipHeight = refs.chartTooltip.offsetHeight;
  const left = clamp(dotX, tooltipWidth / 2 + 4, stageRect.width - tooltipWidth / 2 - 4);
  const placeBelow = dotY - tooltipHeight - 20 < 0;
  refs.chartTooltip.classList.toggle("is-below", placeBelow);
  refs.chartTooltip.style.left = `${left}px`;
  refs.chartTooltip.style.top = `${dotY}px`;
}

function resetInputs() {
  FIELD_IDS.forEach((id) => {
    document.querySelector(`#${id}`).value = DEFAULTS[id];
  });
  GEARBOX_FIELD_IDS.forEach((id) => {
    document.querySelector(`#${id}`).value = GEARBOX_DEFAULTS[id];
  });
  refs.driveModeInputs.forEach((input) => {
    input.checked = input.value === "motor";
  });
  syncDriveModeUI("motor");
  state.renderWidth = 0;
  update();
  showToast("기본 예제 값으로 초기화했습니다.");
}

function bindEvents() {
  refs.form.addEventListener("input", scheduleUpdate);
  refs.form.addEventListener("submit", (event) => event.preventDefault());
  refs.resetButton.addEventListener("click", resetInputs);
  refs.downloadButtons.forEach((button) => {
    button.addEventListener("click", () => downloadPlot(button.dataset.format, button));
  });
  refs.chartStage.addEventListener("pointermove", handlePointerMove);
  refs.chartStage.addEventListener("pointerleave", hideTooltip);
  refs.chartStage.addEventListener("pointercancel", hideTooltip);
  window.addEventListener("scroll", hideTooltip, { passive: true });

  const resizeObserver = new ResizeObserver((entries) => {
    if (!state.analysis?.complete) return;
    const entry = entries[0];
    if (!entry) return;
    const nextWidth = Math.round(entry.contentRect.width);
    if (!nextWidth || Math.abs(nextWidth - state.renderWidth) < 3) return;
    if (resizeFrame) cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = 0;
      renderChart();
    });
  });
  resizeObserver.observe(refs.chart);
}

function init() {
  refs.year.textContent = String(new Date().getFullYear());
  bindEvents();
  update();
  window.addEventListener("load", () => {
    if (state.analysis?.complete) renderChart();
  });
}

init();
