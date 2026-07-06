#!/usr/bin/env node
/**
 * Custom Pac-Man contribution graph generator.
 *
 * Unlike stock pacman/snake-eats-contributions actions, this:
 *  - Sizes/colors pellets by ACTUAL commit count that day (not binary on/off)
 *  - Flags high-activity days as glowing "power pellets"
 *  - Slows Pac-Man's dwell time on cells proportional to that day's commits
 *  - Colors ghosts by day-of-week instead of arbitrarily
 *  - Renders longest-streak window with a highlighted track segment
 *
 * Requires: Node 18+ (global fetch), env vars GH_USERNAME, GH_TOKEN
 */

const fs = require("fs");
const path = require("path");

const USERNAME = process.env.GH_USERNAME;
const TOKEN = process.env.GH_TOKEN;
const OUT_DIR = process.env.OUT_DIR || "output";

if (!USERNAME || !TOKEN) {
  console.error("Missing GH_USERNAME or GH_TOKEN env vars.");
  process.exit(1);
}

const QUERY = `
query($login: String!) {
  user(login: $login) {
    contributionsCollection {
      contributionCalendar {
        totalContributions
        weeks {
          contributionDays {
            date
            contributionCount
            color
          }
        }
      }
    }
  }
}`;

async function fetchCalendar() {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: QUERY, variables: { login: USERNAME } }),
  });

  if (!res.ok) {
    throw new Error(`GitHub API error: ${res.status} ${await res.text()}`);
  }

  const json = await res.json();
  if (json.errors) {
    throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
  }

  return json.data.user.contributionsCollection.contributionCalendar;
}

/**
 * Flatten weeks into a boustrophedon (snake/zigzag) path so Pac-Man
 * travels a continuous line: down column 0, across, up column 1, etc.
 * This is what makes it look like a maze corridor rather than a grid scan.
 */
function buildPath(weeks) {
  const cells = [];
  weeks.forEach((week, colIndex) => {
    const days = week.contributionDays;
    const ordered = colIndex % 2 === 0 ? days : [...days].reverse();
    ordered.forEach((day, i) => {
      const rowIndex = colIndex % 2 === 0 ? i : days.length - 1 - i;
      cells.push({
        col: colIndex,
        row: rowIndex,
        date: day.date,
        count: day.contributionCount,
      });
    });
  });
  return cells;
}

function computeStreaks(cells) {
  // cells are already in chronological column order but NOT chronological
  // overall (boustrophedon reorders rows) — rebuild chronological list first.
  const chrono = [...cells].sort((a, b) => new Date(a.date) - new Date(b.date));
  let longest = { len: 0, startIdx: -1, endIdx: -1 };
  let cur = 0, curStart = 0;
  chrono.forEach((c, i) => {
    if (c.count > 0) {
      if (cur === 0) curStart = i;
      cur++;
      if (cur > longest.len) longest = { len: cur, startIdx: curStart, endIdx: i };
    } else {
      cur = 0;
    }
  });
  const longestDates = new Set(
    chrono.slice(longest.startIdx, longest.endIdx + 1).map((c) => c.date)
  );
  return { longestLen: longest.len, longestDates };
}

function percentileThreshold(cells, pct = 0.9) {
  const counts = cells.map((c) => c.count).filter((n) => n > 0).sort((a, b) => a - b);
  if (counts.length === 0) return Infinity;
  const idx = Math.min(counts.length - 1, Math.floor(counts.length * pct));
  return counts[idx];
}

const DAY_COLORS = {
  0: "#ff2d55", // Sun
  1: "#ff9f0a", // Mon
  2: "#ffd60a", // Tue
  3: "#30d158", // Wed
  4: "#64d2ff", // Thu
  5: "#5e5ce6", // Fri
  6: "#bf5af2", // Sat
};

function renderSVG(cells, meta, theme) {
  const cellSize = 12;
  const gap = 4;
  const stride = cellSize + gap;
  const marginLeft = 30;
  const marginTop = 30;

  const maxCol = Math.max(...cells.map((c) => c.col));
  const maxRow = 6;

  const width = marginLeft + (maxCol + 1) * stride + 20;
  const height = marginTop + (maxRow + 1) * stride + 90; // extra for HUD

  const bg = theme === "dark" ? "#0d1117" : "#ffffff";
  const fg = theme === "dark" ? "#c9d1d9" : "#24292f";
  const powerColor = "#ffd60a";

  const powerThreshold = percentileThreshold(cells, 0.9);
  const { longestLen, longestDates } = computeStreaks(cells);

  // ordered path (boustrophedon order = animation order)
  const points = cells.map((c) => ({
    x: marginLeft + c.col * stride + cellSize / 2,
    y: marginTop + c.row * stride + cellSize / 2,
    ...c,
  }));

  const totalCells = points.length;
  // base step duration; scaled per-cell by commit count below via keyTimes
  const baseStep = 0.12; // seconds per empty-day cell
  const maxExtra = 0.18; // extra seconds added for the busiest day

  const maxCount = Math.max(1, ...points.map((p) => p.count));
  const stepDurations = points.map((p) =>
    baseStep + (p.count / maxCount) * maxExtra
  );
  const totalDuration = stepDurations.reduce((a, b) => a + b, 0);

  // Build cumulative keyTimes for pacman's animateMotion along an explicit path
  let acc = 0;
  const keyTimes = [0];
  stepDurations.forEach((d) => {
    acc += d;
    keyTimes.push(acc / totalDuration);
  });

  const pathD = points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`)
    .join(" ");

  const pellets = points
    .map((p, i) => {
      if (p.count === 0) return "";
      const isPower = p.count >= powerThreshold;
      const r = isPower ? 4.5 : 1.5 + Math.min(2.5, (p.count / maxCount) * 2.5);
      const color = isPower ? powerColor : "#8fd3ff";
      const eatBegin = (keyTimes[i] * totalDuration).toFixed(3);
      const glow = isPower
        ? `<animate attributeName="opacity" values="1;0.4;1" dur="0.6s" repeatCount="indefinite"/>`
        : "";
      return `
      <circle cx="${p.x}" cy="${p.y}" r="${r}" fill="${color}">
        ${glow}
        <animate attributeName="opacity" from="1" to="0" begin="${eatBegin}s" dur="0.15s" fill="freeze"/>
      </circle>`;
    })
    .join("\n");

  // Highlight the longest-streak corridor with a faint underlay track
  const streakUnderlay = points
    .filter((p) => longestDates.has(p.date))
    .map(
      (p) =>
        `<rect x="${p.x - cellSize / 2}" y="${p.y - cellSize / 2}" width="${cellSize}" height="${cellSize}" rx="3" fill="${powerColor}" opacity="0.12"/>`
    )
    .join("\n");

  // Ghosts: 3 ghosts trailing pacman on the same path, offset in time,
  // colored by the day-of-week of the cell they currently occupy.
  const ghostOffsets = [-0.6, -1.1, -1.6]; // seconds behind pacman, roughly
  const ghosts = ghostOffsets
    .map((offset, gi) => {
      const dow = (gi + 1) % 7;
      const color = DAY_COLORS[dow];
      return `
      <g opacity="0.85">
        <circle r="5" fill="${color}">
          <animateMotion dur="${totalDuration}s" repeatCount="indefinite" keyPoints="${keyTimes
            .map((_, i) => (i / (keyTimes.length - 1)).toFixed(4))
            .join(";")}" keyTimes="${keyTimes.map((t) => t.toFixed(4)).join(";")}"
            path="${pathD}" begin="${offset}s"/>
        </circle>
      </g>`;
    })
    .join("\n");

  const pacman = `
      <g>
        <path d="M 0,0 L 8,-4 A 8,8 0 1 1 8,4 Z" fill="#ffe14d">
          <animateTransform attributeName="transform" type="rotate"
            values="0;-20;0;20;0" dur="0.25s" repeatCount="indefinite" additive="sum"/>
        </path>
        <animateMotion dur="${totalDuration}s" repeatCount="indefinite"
          keyPoints="${keyTimes.map((_, i) => (i / (keyTimes.length - 1)).toFixed(4)).join(";")}"
          keyTimes="${keyTimes.map((t) => t.toFixed(4)).join(";")}"
          path="${pathD}" rotate="auto"/>
      </g>`;

  const hudY = height - 60;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="${bg}"/>
  ${streakUnderlay}
  ${pellets}
  ${ghosts}
  ${pacman}
  <g fill="${fg}" font-family="Segoe UI, Helvetica, sans-serif" font-size="12">
    <text x="${marginLeft}" y="${hudY}">Total contributions: ${meta.totalContributions}</text>
    <text x="${marginLeft}" y="${hudY + 18}">Longest streak: ${longestLen} days (highlighted track)</text>
    <text x="${marginLeft}" y="${hudY + 36}">Power pellets = top 10% commit days</text>
  </g>
</svg>`;
}

async function main() {
  const calendar = await fetchCalendar();
  const cells = buildPath(calendar.weeks);
  const meta = { totalContributions: calendar.totalContributions };

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const dark = renderSVG(cells, meta, "dark");
  const light = renderSVG(cells, meta, "light");

  fs.writeFileSync(path.join(OUT_DIR, "pacman-contribution-graph-dark.svg"), dark);
  fs.writeFileSync(path.join(OUT_DIR, "pacman-contribution-graph.svg"), light);

  console.log(`Wrote SVGs to ${OUT_DIR}/`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
