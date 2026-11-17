"use strict";

const DEFAULTS = Object.freeze({
  ratedTorque: 24,
  ratedSpeed: 3000,
  checkTorque: 12,
  checkSpeed: 3600,
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
  paper: "#ffffff",
  plot: "#ffffff",
  ink: "#1f2328",
  inkSoft: "#424a53",
  muted: "#656d76",
  grid: "#eaeef2",
  border: "#d0d7de",
  axis: "#8c959f",
  accent: "#0969da",
  green: "#1a7f37",
  guide: "#8c959f",
  warning: "#9a6700",
  fill300: "#f1f4f7",
  fill100: "#dfe6ed",
});

const MONO = "ui-monospace, 'SFMono-Regular', 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace";

const refs = {
  form: document.querySelector("#curveForm"),
  resetButton: document.querySelector("#resetButton"),
  formMessage: document.querySelector("#formMessage"),
  equation: document.querySelector("#equation"),
  equationNote: document.querySelector("#equationNote"),
  plotSub: document.querySelector("#plotSub"),
  noGearbox: document.querySelector("#noGearbox"),
  gearRatio: document.querySelector("#gearRatio"),
  gearEfficiency: document.querySelector("#gearEfficiency"),
  chart: document.querySelector("#chart"),
  chartStage: document.querySelector("#chartStage"),
  chartTooltip: document.querySelector("#chartTooltip"),
  tooltipSpeed: document.querySelector("#tooltipSpeed"),
  tooltipTorque: document.querySelector("#tooltipTorque"),
  stallTorque: document.querySelector("#stallTorque"),
  zeroTorqueSpeed: document.querySelector("#zeroTorqueSpeed"),
  slopeMetric: document.querySelector("#slopeMetric"),
  downloadButtons: [...document.querySelectorAll("[data-format]")],
  captureButton: document.querySelector("#captureButton"),
  cautionButton: document.querySelector("#cautionButton"),
  cautionDialog: document.querySelector("#cautionDialog"),
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
let savedGearbox = {
  ratio: String(GEARBOX_DEFAULTS.gearRatio),
  efficiency: String(GEARBOX_DEFAULTS.gearEfficiency),
};

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

  const noGearbox = document.querySelector("#noGearbox").checked;
  return {
    values,
    gearbox,
    noGearbox,
  };
}

function analyze(formValues) {
  const { values: motorValues, gearbox, noGearbox } = formValues;
  const errors = [];
  const warnings = [];
  const invalidFields = new Set();

  const missing = FIELD_IDS.filter((id) => !Number.isFinite(motorValues[id]));
  if (missing.length > 0) {
    missing.forEach((id) => invalidFields.add(id));
    errors.push("Enter a number for every motor value.");
  } else {
    const nonPositive = FIELD_IDS.filter((id) => motorValues[id] <= 0);
    if (nonPositive.length > 0) {
      nonPositive.forEach((id) => invalidFields.add(id));
      errors.push("Motor values must be greater than zero.");
    }
  }

  if (!noGearbox) {
    if (!Number.isFinite(gearbox.gearRatio)) {
      invalidFields.add("gearRatio");
      errors.push("Enter a reduction ratio.");
    } else if (gearbox.gearRatio < 1) {
      invalidFields.add("gearRatio");
      errors.push("Reduction ratio must be at least 1.");
    }

    if (!Number.isFinite(gearbox.gearEfficiency)) {
      invalidFields.add("gearEfficiency");
      errors.push("Enter a rated efficiency.");
    } else if (gearbox.gearEfficiency <= 0 || gearbox.gearEfficiency > 100) {
      invalidFields.add("gearEfficiency");
      errors.push("Rated efficiency must be greater than 0% and at most 100%.");
    }
  }

  let slope = null;
  let intercept = null;
  let zeroTorqueSpeed = null;
  let threeSpeed = null;
  let threeIntersection = false;
  let outputValues = null;

  if (errors.length === 0) {
    const ratio = noGearbox ? 1 : gearbox.gearRatio;
    const efficiency = noGearbox ? 1 : gearbox.gearEfficiency / 100;

    outputValues = {
      ratedTorque: motorValues.ratedTorque * ratio * efficiency,
      ratedSpeed: motorValues.ratedSpeed / ratio,
      checkTorque: motorValues.checkTorque * ratio * efficiency,
      checkSpeed: motorValues.checkSpeed / ratio,
    };

    const { ratedTorque, ratedSpeed, checkTorque, checkSpeed } = outputValues;

    if (ratedSpeed === checkSpeed) {
      errors.push("Rated speed and check speed must differ.");
      invalidFields.add("ratedSpeed");
      invalidFields.add("checkSpeed");
    } else {
      slope = (checkTorque - ratedTorque) / (checkSpeed - ratedSpeed);
      if (!Number.isFinite(slope) || slope >= 0) {
        errors.push("Torque must decrease as speed increases. Check the direction of the two points.");
        ["ratedTorque", "ratedSpeed", "checkTorque", "checkSpeed"].forEach((id) => invalidFields.add(id));
        slope = null;
      }
    }

    if (slope !== null) {
      intercept = ratedTorque - slope * ratedSpeed;
      zeroTorqueSpeed = -intercept / slope;

      if (!Number.isFinite(intercept) || !Number.isFinite(zeroTorqueSpeed) || intercept <= 0 || zeroTorqueSpeed <= 0) {
        errors.push("These points do not produce positive axis intercepts. Check the values.");
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
        warnings.push("300% rated torque is above the stall torque, so the 300% guide never meets the curve.");
      }

      if (threeSpeed !== null && threeSpeed < 1) {
        warnings.push("The 300% guide only touches the curve near 0 rpm.");
      }
    }
  }

  const complete = errors.length === 0 && slope !== null;

  return {
    noGearbox,
    gearbox: !noGearbox
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
  };
}

function scheduleUpdate() {
  if (updateFrame) cancelAnimationFrame(updateFrame);
  updateFrame = requestAnimationFrame(() => {
    updateFrame = 0;
    update();
  });
}

function updatePlotContext(analysis) {
  if (analysis.noGearbox) {
    refs.plotSub.textContent = "Motor shaft · no gearbox";
    return;
  }

  if (analysis.gearbox) {
    const ratio = formatPlain(analysis.gearbox.ratio);
    const efficiency = formatPlain(analysis.gearbox.efficiency);
    refs.plotSub.textContent = `Gearbox output · ${ratio}:1 reduction · η ${efficiency}%`;
    return;
  }

  refs.plotSub.textContent = "Motor shaft";
}

function update() {
  const formValues = readFormValues();
  const analysis = analyze(formValues);
  state.analysis = analysis;

  ALL_FIELD_IDS.forEach((id) => {
    const input = document.querySelector(`#${id}`);
    if (analysis.invalidFields.has(id)) input.setAttribute("aria-invalid", "true");
    else input.removeAttribute("aria-invalid");
  });

  updateFormMessage(analysis);
  updatePlotContext(analysis);

  if (!analysis.complete) {
    state.chart = null;
    updateEquation(null);
    updateMetrics(analysis);
    renderChartError(analysis.errors[0] || "The curve cannot be plotted.");
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

function updateEquation(analysis) {
  if (!analysis) {
    refs.equation.textContent = "—";
    refs.equationNote.textContent = "T [Nm] · N [rpm]";
    return;
  }

  const slopeMagnitude = coefficient(Math.abs(analysis.slope));
  refs.equation.textContent = `T = ${formatTorque(analysis.intercept)} − ${slopeMagnitude} × N`;

  if (analysis.noGearbox) {
    refs.equationNote.textContent = "Motor shaft · no gearbox";
  } else if (analysis.gearbox) {
    refs.equationNote.textContent = `Output shaft · N ÷ ${formatPlain(analysis.gearbox.ratio)} · T × ${formatPlain(analysis.gearbox.ratio)} × ${formatPlain(analysis.gearbox.efficiency)}%`;
  } else {
    refs.equationNote.textContent = "T [Nm] · N [rpm]";
  }
}

function updateMetrics(analysis) {
  if (!analysis.complete) {
    refs.stallTorque.innerHTML = "—";
    refs.zeroTorqueSpeed.innerHTML = `— <span>rpm</span>`;
    refs.slopeMetric.innerHTML = "—";
    return;
  }

  refs.stallTorque.innerHTML = `${formatTorque(analysis.intercept)} <span>Nm</span>`;
  refs.zeroTorqueSpeed.innerHTML = `${formatSpeed(analysis.zeroTorqueSpeed)} <span>rpm</span>`;
  refs.slopeMetric.innerHTML = `${formatTorque(analysis.slope * 1000)} <span>Nm</span>`;
}

function renderChartError(message) {
  hideTooltip();
  refs.chart.innerHTML = `
    <div class="chart-empty" role="img" aria-label="Plot unavailable">
      <strong>Plot unavailable</strong>
      <p class="chart-empty-message"></p>
    </div>`;
  refs.chart.querySelector(".chart-empty-message").textContent = message;
}

function renderChart() {
  if (!state.analysis?.complete) return;

  const width = Math.round(refs.chart.clientWidth || refs.chartStage.clientWidth || 900);
  if (width < 80) return;

  const compact = width < 760;
  const height = Math.round(clamp(width * 0.64, compact ? 400 : 500, 640));
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
  } = options;

  const mini = width < 420;
  const scale = width < 760 ? 1 : clamp(width / 1100, 1, 1.12);
  const margins = {
    left: compact ? 64 : 78,
    right: compact ? 16 : 26,
    top: compact ? 28 : 34,
    bottom: compact ? 62 : 72,
  };
  const plotLeft = margins.left;
  const plotTop = margins.top;
  const plotRight = width - margins.right;
  const plotBottom = height - margins.bottom;
  const plotWidth = plotRight - plotLeft;
  const plotHeight = plotBottom - plotTop;

  const font = {
    tick: 16 * scale,
    axisTitle: 16 * scale,
    guide: 16 * scale,
    pointTitle: 16 * scale,
    pointValue: 17 * scale,
  };

  const { values, intercept, slope, zeroTorqueSpeed, threeTimesRated, threeSpeed } = analysis;
  const t3 = threeTimesRated;
  const xMax = Math.max(zeroTorqueSpeed, values.ratedSpeed, values.checkSpeed) * 1.06;
  const yMax = Math.max(intercept, t3, values.ratedTorque * 1.2) * 1.08;
  const xTickData = makeTicks(xMax, compact ? (width < 420 ? 4 : 5) : 6);
  const yTickData = makeTicks(yMax, 5);

  const mapX = (value) => plotLeft + (value / xMax) * plotWidth;
  const mapY = (value) => plotTop + (1 - value / yMax) * plotHeight;

  const ratedX = mapX(values.ratedSpeed);
  const ratedY = mapY(values.ratedTorque);
  const checkX = mapX(values.checkSpeed);
  const checkY = mapY(values.checkTorque);
  const ratedGuideX = ratedX;
  const ratedGuideY = ratedY;
  const threeGuideY = mapY(t3);
  const threeGuideX = threeSpeed !== null ? mapX(Math.max(0, threeSpeed)) : null;

  const ratedGuideFullText = "100% RATED";
  const ratedGuideShortText = "100%";
  const ratedGuideCanUseFull = ratedGuideX - 12 - ratedGuideFullText.length * font.guide * 0.62 >= plotLeft + 4;
  const ratedGuideText = mini || !ratedGuideCanUseFull ? ratedGuideShortText : ratedGuideFullText;
  const ratedGuideWidth = ratedGuideText.length * font.guide * 0.62;
  const placeRatedGuideBelow = ratedGuideY + 26 <= plotBottom
    && ratedGuideX - 12 - ratedGuideWidth >= plotLeft + 4;
  const ratedGuideLabelY = placeRatedGuideBelow
    ? ratedGuideY + 22
    : Math.max(ratedGuideY - 7, plotTop + font.guide);
  const ratedGuideLabelX = placeRatedGuideBelow ? ratedGuideX - 12 : plotLeft + 6;
  const ratedGuideLabelAnchor = placeRatedGuideBelow ? "end" : "start";
  const ratedGuideLabelBox = {
    x: placeRatedGuideBelow ? ratedGuideLabelX - ratedGuideWidth : ratedGuideLabelX,
    y: ratedGuideLabelY - font.guide * 0.8,
    width: ratedGuideWidth + 4,
    height: font.guide + 4,
  };

  const ratedTorqueLabel = `${formatTorque(values.ratedTorque)} Nm`;
  const ratedSpeedLabel = `${formatSpeed(values.ratedSpeed)} rpm`;
  const checkTorqueLabel = `${formatTorque(values.checkTorque)} Nm`;
  const checkSpeedLabel = `${formatSpeed(values.checkSpeed)} rpm`;
  const pointPlot = { left: plotLeft, right: plotRight, top: plotTop, bottom: plotBottom };
  const curveLine = {
    x1: plotLeft,
    y1: mapY(intercept),
    x2: mapX(zeroTorqueSpeed),
    y2: plotBottom,
  };
  const ratedMarker = { x: ratedX - 7, y: ratedY - 7, width: 14, height: 14 };
  const checkMarker = { x: checkX - 7, y: checkY - 7, width: 14, height: 14 };
  const guideObstacles = [
    { x: plotLeft, y: ratedGuideY - 1, width: ratedGuideX - plotLeft, height: 2 },
    ratedGuideLabelBox,
  ];
  if (threeGuideX !== null) {
    guideObstacles.push({ x: plotLeft, y: threeGuideY - 1, width: threeGuideX - plotLeft, height: 2 });
  }

  const ratedLabel = pointAnnotation({
    x: ratedX,
    y: ratedY,
    title: "RATED",
    speedLabel: ratedSpeedLabel,
    torqueLabel: ratedTorqueLabel,
    color: COLORS.accent,
    compact,
    mini,
    font,
    plot: pointPlot,
    preferred: "above",
    obstacles: [...guideObstacles, checkMarker],
    curve: curveLine,
  });

  const checkLabel = pointAnnotation({
    x: checkX,
    y: checkY,
    title: "CHECK",
    speedLabel: checkSpeedLabel,
    torqueLabel: checkTorqueLabel,
    color: COLORS.green,
    compact,
    mini,
    font,
    plot: pointPlot,
    preferred: "below",
    obstacles: [...guideObstacles, ratedMarker, ratedLabel.rect],
    curve: curveLine,
  });

  const pointMarkup = ratedLabel.svg + checkLabel.svg;

  const verticalGrid = xTickData
    .filter((tick) => tick.value > 0)
    .map(
      (tick) =>
        `<line x1="${mapX(tick.value)}" y1="${plotTop}" x2="${mapX(tick.value)}" y2="${plotBottom}" stroke="${COLORS.grid}" stroke-width="1" />`,
    )
    .join("");

  const horizontalGrid = yTickData
    .filter((tick) => tick.value > 0)
    .map(
      (tick) =>
        `<line x1="${plotLeft}" y1="${mapY(tick.value)}" x2="${plotRight}" y2="${mapY(tick.value)}" stroke="${COLORS.grid}" stroke-width="1" />`,
    )
    .join("");

  const xTickLabels = xTickData
    .map((tick) => {
      const x = mapX(tick.value);
      const tickLabel = compact
        ? formatCompactAxisValue(tick.value, tick.step)
        : formatAxisValue(tick.value, tick.step);
      return `
        <line x1="${x}" y1="${plotBottom}" x2="${x}" y2="${plotBottom + 5}" stroke="${COLORS.axis}" stroke-width="1" />
        <text x="${x}" y="${plotBottom + (compact ? 24 : 27)}" text-anchor="middle" class="chart-tick">${tickLabel}</text>`;
    })
    .join("");

  const yTickLabels = yTickData
    .map((tick) => {
      const y = mapY(tick.value);
      return `
        <line x1="${plotLeft - 5}" y1="${y}" x2="${plotLeft}" y2="${y}" stroke="${COLORS.axis}" stroke-width="1" />
        ${tick.value > 0 ? `<text x="${plotLeft - (compact ? 9 : 12)}" y="${y + font.tick * 0.34}" text-anchor="end" class="chart-tick">${formatAxisValue(tick.value, tick.step)}</text>` : ""}`;
    })
    .join("");

  const guideLabels = [];
  const threeLabelY = Math.max(threeGuideY - 7, plotTop + font.guide);
  if (threeGuideX !== null) {
    guideLabels.push(
      guideText({
        text: mini ? "300%" : "300% RATED",
        x: threeGuideX + 8,
        y: threeLabelY,
        anchor: "start",
        font,
        color: COLORS.guide,
        maxX: plotRight - 4,
      }),
    );
  } else {
    guideLabels.push(`
      <line x1="${plotLeft}" y1="${threeGuideY}" x2="${plotRight}" y2="${threeGuideY}" stroke="${COLORS.warning}" stroke-width="1.5" stroke-dasharray="4 6" stroke-linecap="round" opacity=".85" />
      ${guideText({
        text: mini ? "300% · ABOVE CURVE" : "300% RATED · ABOVE CURVE",
        x: plotLeft + 6,
        y: threeLabelY,
        anchor: "start",
        font,
        color: COLORS.warning,
        maxX: plotRight - 4,
      })}
    `);
  }

  guideLabels.push(
    guideText({
      text: ratedGuideText,
      x: ratedGuideLabelX,
      y: ratedGuideLabelY,
      anchor: ratedGuideLabelAnchor,
      font,
      color: COLORS.inkSoft,
      maxX: plotRight - 4,
    }),
  );

  const fills = [];
  if (threeGuideX !== null) {
    fills.push(`<path d="M ${plotLeft} ${plotBottom} L ${threeGuideX} ${plotBottom} L ${threeGuideX} ${threeGuideY} L ${plotLeft} ${threeGuideY} Z" fill="${COLORS.fill300}" />`);
  }
  fills.push(`<path d="M ${plotLeft} ${plotBottom} L ${ratedGuideX} ${plotBottom} L ${ratedGuideX} ${ratedGuideY} L ${plotLeft} ${ratedGuideY} Z" fill="${COLORS.fill100}" />`);

  const basisTitle = analysis.noGearbox ? "Motor shaft — " : "Gearbox output — ";
  const title = `${basisTitle}TN Curve — ${formatTorque(values.ratedTorque)} Nm @ ${formatSpeed(values.ratedSpeed)} rpm to ${formatTorque(values.checkTorque)} Nm @ ${formatSpeed(values.checkSpeed)} rpm`;
  const basisDescription = analysis.noGearbox
    ? " Motor shaft basis. No gearbox; ratio 1, efficiency 100 percent."
    : ` Gearbox output basis. Reduction ratio ${formatPlain(analysis.gearbox.ratio)} to 1; rated efficiency ${formatPlain(analysis.gearbox.efficiency)} percent.`;
  const description = `Torque-speed curve. Stall torque ${formatTorque(intercept)} Nm at 0 rpm; max speed at no load ${formatSpeed(zeroTorqueSpeed)} rpm. Rated torque guide ${formatTorque(values.ratedTorque)} Nm; 300 percent guide ${formatTorque(t3)} Nm.${basisDescription}`;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${pixelWidth}" height="${pixelHeight}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="tnCurveTitle tnCurveDesc">
    <title id="tnCurveTitle">${escapeXML(title)}</title>
    <desc id="tnCurveDesc">${escapeXML(description)}</desc>
    <style>
      .chart-tick { font-family: ${MONO}; font-size: ${font.tick}px; fill: ${COLORS.muted}; font-variant-numeric: tabular-nums; }
      .chart-axis-title { font-family: ${MONO}; font-size: ${font.axisTitle}px; fill: ${COLORS.inkSoft}; font-weight: 600; letter-spacing: .08em; }
      .chart-guide-label { font-family: ${MONO}; font-size: ${font.guide}px; font-weight: 600; letter-spacing: .02em; paint-order: stroke; stroke: ${COLORS.paper}; stroke-width: 3px; stroke-linejoin: round; }
      .chart-point-title { font-family: ${MONO}; font-size: ${font.pointTitle}px; font-weight: 700; letter-spacing: .05em; paint-order: stroke; stroke: ${COLORS.paper}; stroke-width: 3.5px; stroke-linejoin: round; }
      .chart-point-value { font-family: ${MONO}; font-size: ${font.pointValue}px; font-weight: 600; fill: ${COLORS.ink}; font-variant-numeric: tabular-nums; paint-order: stroke; stroke: ${COLORS.paper}; stroke-width: 3.5px; stroke-linejoin: round; }
      .chart-hit { cursor: crosshair; }
    </style>
    <rect width="${width}" height="${height}" fill="${COLORS.paper}" />
    <rect x="${plotLeft}" y="${plotTop}" width="${plotWidth}" height="${plotHeight}" fill="${COLORS.plot}" stroke="${COLORS.border}" stroke-width="1" />
    <g aria-hidden="true">${fills.join("")}</g>
    <g aria-hidden="true">${verticalGrid}${horizontalGrid}</g>
    <line x1="${plotLeft}" y1="${threeGuideY}" x2="${threeGuideX ?? plotRight}" y2="${threeGuideY}" stroke="${COLORS.guide}" stroke-width="1.5" stroke-dasharray="4 6" stroke-linecap="round" opacity="${threeGuideX !== null ? ".9" : "0"}" />
    <line x1="${plotLeft}" y1="${ratedGuideY}" x2="${ratedGuideX}" y2="${ratedGuideY}" stroke="${COLORS.inkSoft}" stroke-width="1.5" stroke-dasharray="4 6" stroke-linecap="round" />
    ${threeGuideX !== null ? `<circle cx="${threeGuideX}" cy="${threeGuideY}" r="3" fill="${COLORS.paper}" stroke="${COLORS.guide}" stroke-width="1.2" />` : ""}
    <circle cx="${ratedGuideX}" cy="${ratedGuideY}" r="3" fill="${COLORS.paper}" stroke="${COLORS.inkSoft}" stroke-width="1.2" />
    <line x1="${plotLeft}" y1="${mapY(intercept)}" x2="${mapX(zeroTorqueSpeed)}" y2="${mapY(0)}" stroke="${COLORS.ink}" stroke-width="2.6" stroke-linecap="round" />
    <g aria-hidden="true">
      <circle cx="${plotLeft}" cy="${mapY(intercept)}" r="4" fill="${COLORS.paper}" stroke="${COLORS.ink}" stroke-width="1.6" />
      <circle cx="${mapX(zeroTorqueSpeed)}" cy="${plotBottom}" r="4" fill="${COLORS.paper}" stroke="${COLORS.ink}" stroke-width="1.6" />
    </g>
    <g aria-hidden="true">
      <line x1="${plotLeft}" y1="${plotTop}" x2="${plotLeft}" y2="${plotBottom}" stroke="${COLORS.axis}" stroke-width="1" />
      <line x1="${plotLeft}" y1="${plotBottom}" x2="${plotRight}" y2="${plotBottom}" stroke="${COLORS.axis}" stroke-width="1" />
      ${xTickLabels}
      ${yTickLabels}
      <text x="${plotLeft + plotWidth / 2}" y="${plotBottom + (compact ? 54 : 60)}" text-anchor="middle" class="chart-axis-title">SPEED [rpm]</text>
      <text x="${compact ? 16 : 20}" y="${plotTop + plotHeight / 2}" text-anchor="middle" class="chart-axis-title" transform="rotate(-90 ${compact ? 16 : 20} ${plotTop + plotHeight / 2})">TORQUE [Nm]</text>
    </g>
    <g aria-hidden="true">${guideLabels.join("")}</g>
    <g aria-hidden="true">
      <circle cx="${ratedX}" cy="${ratedY}" r="6" fill="${COLORS.paper}" stroke="${COLORS.accent}" stroke-width="2.4" />
      <circle cx="${ratedX}" cy="${ratedY}" r="2.2" fill="${COLORS.accent}" />
      <circle cx="${checkX}" cy="${checkY}" r="6" fill="${COLORS.paper}" stroke="${COLORS.green}" stroke-width="2.4" />
      <circle cx="${checkX}" cy="${checkY}" r="2.2" fill="${COLORS.green}" />
    </g>
    ${pointMarkup}
    <g class="hover-layer" opacity="0" pointer-events="none" aria-hidden="true">
      <line class="hover-line" x1="${plotLeft}" y1="${plotTop}" x2="${plotLeft}" y2="${plotBottom}" stroke="${COLORS.accent}" stroke-width="1.2" stroke-dasharray="4 5" opacity=".6" />
      <circle class="hover-dot" cx="${plotLeft}" cy="${plotBottom}" r="5" fill="${COLORS.paper}" stroke="${COLORS.accent}" stroke-width="2.2" />
    </g>
    <rect class="chart-hit" x="${plotLeft}" y="${plotTop}" width="${plotWidth}" height="${plotHeight}" fill="#000000" fill-opacity="0" pointer-events="all" aria-label="Move over the plot to read speed and torque" />
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

function guideText({ text, x, y, anchor, font, color, maxX }) {
  const width = text.length * font.guide * 0.62;
  const textX = maxX !== undefined ? Math.min(x, maxX - width) : x;
  return `<text x="${textX}" y="${y}" text-anchor="${anchor}" class="chart-guide-label" fill="${color}">${escapeXML(text)}</text>`;
}

function pointAnnotation({
  x,
  y,
  title,
  speedLabel,
  torqueLabel,
  color,
  compact,
  mini,
  font,
  plot,
  preferred,
  obstacles,
  curve,
}) {
  const titleText = mini ? title : compact ? `${title} · ${torqueLabel}` : `${title} · ${speedLabel}`;
  const showValue = !mini && !compact;
  const titleSize = font.pointTitle;
  const valueSize = font.pointValue;
  const titleWidth = titleText.length * titleSize * 0.62;
  const valueWidth = torqueLabel.length * valueSize * 0.6;
  const width = Math.ceil(Math.max(titleWidth, showValue ? valueWidth : 0)) + 4;
  const lineGap = 3;
  const height = showValue ? Math.ceil(titleSize + lineGap + valueSize) + 2 : Math.ceil(titleSize) + 8;
  const gap = 10;
  const verticalOrder = preferred === "below" ? ["below", "above"] : ["above", "below"];
  const candidates = [];

  verticalOrder.forEach((vertical) => {
    ["right", "left"].forEach((horizontal) => {
      candidates.push({
        vertical,
        horizontal,
        x: horizontal === "right" ? x + gap : x - gap - width,
        y: vertical === "above" ? y - gap - height : y + gap,
      });
    });
  });

  const bounded = candidates.map((candidate) => ({
    ...candidate,
    x: clamp(candidate.x, plot.left + 4, plot.right - width - 4),
    fits: candidate.y >= plot.top + 4 && candidate.y + height <= plot.bottom - 4,
  }));

  let chosen = null;
  for (const candidate of bounded) {
    if (!candidate.fits) continue;
    const rect = { x: candidate.x, y: candidate.y, width, height };
    const blocked = obstacles.some((box) => rectanglesIntersect(rect, box, 5));
    const crossesCurve = lineIntersectsRect(curve.x1, curve.y1, curve.x2, curve.y2, rect, 5);
    if (!blocked && !crossesCurve) {
      chosen = { ...candidate, width, height };
      break;
    }
  }

  if (!chosen) {
    const fallback = bounded.find((candidate) => candidate.fits) || bounded[0];
    chosen = {
      ...fallback,
      width,
      height,
      y: clamp(fallback.y, plot.top + 4, plot.bottom - height - 4),
    };
  }

  const anchor = chosen.horizontal === "right" ? "start" : "end";
  const textX = chosen.horizontal === "right" ? chosen.x : chosen.x + width;
  const titleBaseline = chosen.y + titleSize * 0.92;
  const valueBaseline = chosen.y + titleSize + lineGap + valueSize * 0.86;
  const svg = [
    `<text x="${textX}" y="${titleBaseline}" text-anchor="${anchor}" class="chart-point-title" fill="${color}">${escapeXML(titleText)}</text>`,
    showValue
      ? `<text x="${textX}" y="${valueBaseline}" text-anchor="${anchor}" class="chart-point-value">${escapeXML(torqueLabel)}</text>`
      : "",
  ].join("");

  return {
    rect: { x: chosen.x, y: chosen.y, width, height },
    svg,
  };
}

function lineIntersectsRect(x1, y1, x2, y2, rect, padding = 0) {
  const minX = rect.x - padding;
  const maxX = rect.x + rect.width + padding;
  const minY = rect.y - padding;
  const maxY = rect.y + rect.height + padding;
  const dx = x2 - x1;
  const dy = y2 - y1;
  let t0 = 0;
  let t1 = 1;
  const p = [-dx, dx, -dy, dy];
  const q = [x1 - minX, maxX - x1, y1 - minY, maxY - y1];

  for (let index = 0; index < 4; index += 1) {
    if (p[index] === 0) {
      if (q[index] < 0) return false;
    } else {
      const r = q[index] / p[index];
      if (p[index] < 0) {
        if (r > t1) return false;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return false;
        if (r < t1) t1 = r;
      }
    }
  }
  return true;
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
  [...refs.downloadButtons, refs.captureButton].forEach((button) => {
    button.disabled = !enabled || state.busy;
    button.setAttribute("aria-disabled", String(!enabled || state.busy));
  });
}

function currentFileBase() {
  const analysis = state.analysis;
  const values = analysis.values;
  const gearbox = analysis.noGearbox
    ? ""
    : `_gear${formatFileValue(analysis.gearbox.ratio)}x-${formatFileValue(analysis.gearbox.efficiency)}eff`;
  return `tn-curve${gearbox}_${formatFileValue(values.ratedTorque)}Nm-${formatFileValue(values.ratedSpeed)}rpm`;
}

function exportSvgMarkup() {
  return buildChart(state.analysis, {
    width: LOGICAL_EXPORT_WIDTH,
    height: LOGICAL_EXPORT_HEIGHT,
    compact: false,
    pixelWidth: EXPORT_WIDTH,
    pixelHeight: EXPORT_HEIGHT,
  }).svg;
}

async function downloadPlot(format, button) {
  if (!state.analysis?.complete || state.busy) return;

  state.busy = true;
  setDownloadsEnabled(false);
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
      showToast("SVG plot downloaded.");
    } else {
      const blob = await svgToPngBlob(svgMarkup);
      triggerDownload(blob, `${baseName}.png`);
      showToast("PNG plot downloaded.");
    }
  } catch (error) {
    console.error(error);
    showToast("Could not create the plot file. Try again.", true);
  } finally {
    state.busy = false;
    button.removeAttribute("aria-busy");
    setDownloadsEnabled(Boolean(state.analysis?.complete));
  }
}

async function capturePlot() {
  if (!state.analysis?.complete || state.busy) return;

  state.busy = true;
  setDownloadsEnabled(false);
  refs.captureButton.setAttribute("aria-busy", "true");

  try {
    if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
      throw new Error("Clipboard image copy is not supported");
    }

    const svgMarkup = exportSvgMarkup();
    const blob = await svgToPngBlob(svgMarkup);
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    showToast("Plot copied to the clipboard. Press Ctrl+V to paste.");
  } catch (error) {
    console.error(error);
    showToast("Could not copy the plot. Use the PNG download instead.", true);
  } finally {
    state.busy = false;
    refs.captureButton.removeAttribute("aria-busy");
    setDownloadsEnabled(Boolean(state.analysis?.complete));
  }
}

function openCaution() {
  if (typeof refs.cautionDialog.showModal === "function") {
    refs.cautionDialog.showModal();
  } else {
    refs.cautionDialog.setAttribute("open", "");
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

function handleNoGearboxChange() {
  const checked = refs.noGearbox.checked;
  if (checked) {
    savedGearbox.ratio = refs.gearRatio.value;
    savedGearbox.efficiency = refs.gearEfficiency.value;
    refs.gearRatio.value = "1";
    refs.gearEfficiency.value = "100";
  } else {
    refs.gearRatio.value = savedGearbox.ratio;
    refs.gearEfficiency.value = savedGearbox.efficiency;
  }

  refs.gearRatio.disabled = checked;
  refs.gearEfficiency.disabled = checked;
  state.renderWidth = 0;
  update();
}

function resetInputs() {
  FIELD_IDS.forEach((id) => {
    document.querySelector(`#${id}`).value = DEFAULTS[id];
  });
  GEARBOX_FIELD_IDS.forEach((id) => {
    document.querySelector(`#${id}`).value = GEARBOX_DEFAULTS[id];
  });
  refs.noGearbox.checked = false;
  refs.gearRatio.disabled = false;
  refs.gearEfficiency.disabled = false;
  savedGearbox = {
    ratio: String(GEARBOX_DEFAULTS.gearRatio),
    efficiency: String(GEARBOX_DEFAULTS.gearEfficiency),
  };
  state.renderWidth = 0;
  update();
  showToast("Inputs reset to the example values.");
}

function bindEvents() {
  refs.form.addEventListener("input", scheduleUpdate);
  refs.form.addEventListener("submit", (event) => event.preventDefault());
  refs.noGearbox.addEventListener("change", handleNoGearboxChange);
  refs.resetButton.addEventListener("click", resetInputs);
  refs.captureButton.addEventListener("click", capturePlot);
  refs.cautionButton.addEventListener("click", openCaution);
  refs.cautionDialog.addEventListener("click", (event) => {
    if (event.target === refs.cautionDialog) refs.cautionDialog.close();
  });
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
  if (refs.noGearbox.checked) {
    refs.gearRatio.value = "1";
    refs.gearEfficiency.value = "100";
    refs.gearRatio.disabled = true;
    refs.gearEfficiency.disabled = true;
  }
  bindEvents();
  update();
  window.addEventListener("load", () => {
    if (state.analysis?.complete) renderChart();
  });
}

init();
