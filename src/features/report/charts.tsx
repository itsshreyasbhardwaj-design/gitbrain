import { max } from 'd3-array';
import { scaleBand, scaleLinear } from 'd3-scale';
import { arc } from 'd3-shape';

import type { LanguageBreakdown } from '@/core/types';
import { cn } from '@/lib/cn';
import { formatBytes, formatCount, TONE_VAR, type Tone } from './grade';

/**
 * Report charts.
 *
 * Every chart here is hand-written SVG driven by d3 *scales and generators*
 * only — no d3 selections, no charting library, no client bundle. They render
 * on the server, which is the point: a static report should not ship a
 * rendering engine to draw five rectangles.
 *
 * House rules, applied without exception:
 *   - the SVG is `role="img"` with a summarising `aria-label`, so assistive
 *     tech announces one thing instead of narrating stray `<path>` nodes;
 *   - every chart is followed by a real text equivalent (a `sr-only` table or
 *     a visible legend), because a polygon carries no information on its own;
 *   - colour never encodes anything that is not also written down.
 */

// ---------------------------------------------------------------------------
// Score gauge
// ---------------------------------------------------------------------------

/**
 * 240° of sweep, centred on 12 o'clock. A full circle would read as a pie and
 * a half circle wastes the corners of a square panel; leaving a gap at the base
 * makes the empty portion of the track legible as "unearned score".
 */
const GAUGE_SWEEP = (Math.PI * 4) / 3;
const GAUGE_START = -GAUGE_SWEEP / 2;

export interface ScoreGaugeProps {
  /** 0–100. Values outside the range are clamped rather than overdrawn. */
  value: number;
  /** Letter shown in the centre. */
  grade: string;
  tone: Tone;
  /** Accessible name; also what the label under the number reads. */
  label: string;
  size?: number;
}

export function ScoreGauge({ value, grade, tone, label, size = 200 }: ScoreGaugeProps) {
  const radius = size / 2;
  const thickness = Math.max(12, size * 0.08);

  const ring = arc<{ startAngle: number; endAngle: number }>()
    .innerRadius(radius - thickness)
    .outerRadius(radius)
    .cornerRadius(thickness / 2);

  const clamped = Math.min(100, Math.max(0, value));
  const track = ring({ startAngle: GAUGE_START, endAngle: GAUGE_START + GAUGE_SWEEP }) ?? '';
  // A zero score produces a zero-length arc; d3 returns an empty path for it,
  // which renders as nothing — the desired outcome, not a bug to guard around.
  const filled =
    ring({ startAngle: GAUGE_START, endAngle: GAUGE_START + GAUGE_SWEEP * (clamped / 100) }) ?? '';

  return (
    <figure className="flex flex-col items-center gap-2">
      <svg
        role="img"
        aria-label={`${label}: ${clamped} out of 100, grade ${grade}.`}
        viewBox={`${-radius} ${-radius} ${size} ${size}`}
        className="h-auto w-full"
        style={{ maxWidth: size }}
      >
        <path d={track} fill="var(--color-surface)" />
        <path d={filled} fill={TONE_VAR[tone]} />

        <text
          x={0}
          y={-2}
          textAnchor="middle"
          fill={TONE_VAR[tone]}
          style={{ fontSize: radius * 0.62, fontWeight: 600, letterSpacing: '-0.03em' }}
        >
          {grade}
        </text>
        <text
          x={0}
          y={radius * 0.36}
          textAnchor="middle"
          fill="var(--color-ink-muted)"
          style={{ fontSize: radius * 0.17, fontVariantNumeric: 'tabular-nums' }}
        >
          {clamped} / 100
        </text>
      </svg>
      <figcaption className="text-ink-faint text-[0.6875rem] tracking-wide uppercase">
        {label}
      </figcaption>
    </figure>
  );
}

// ---------------------------------------------------------------------------
// Radar
// ---------------------------------------------------------------------------

export interface RadarAxis {
  readonly label: string;
  /** 0–100. */
  readonly value: number;
}

export interface RadarChartProps {
  axes: readonly RadarAxis[];
  /** Accessible name for the whole figure. */
  title: string;
  /** Column heading for the value column in the text equivalent. */
  valueHeading?: string;
}

/** Rings drawn behind the shape, so a reader can estimate a value off the grid. */
const RADAR_RINGS = [25, 50, 75, 100] as const;
const RADAR_RADIUS = 100;
/**
 * A radar polygon is only readable with three or more axes; with two it is a
 * line and with one it is a dot. Below the threshold we skip the drawing and
 * show the table alone rather than rendering something misleading.
 */
const RADAR_MIN_AXES = 3;

interface Point {
  readonly x: number;
  readonly y: number;
}

/** Polar to cartesian with 0 at 12 o'clock, going clockwise. */
function radarPoint(index: number, count: number, radius: number): Point {
  const angle = -Math.PI / 2 + (index / count) * Math.PI * 2;
  return { x: radius * Math.cos(angle), y: radius * Math.sin(angle) };
}

function toPath(points: readonly Point[]): string {
  return points.map((point) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(' ');
}

export function RadarChart({ axes, title, valueHeading = 'Score' }: RadarChartProps) {
  const count = axes.length;
  const scale = scaleLinear().domain([0, 100]).range([0, RADAR_RADIUS]);

  const vertices = axes.map((axis, index) =>
    radarPoint(index, count, scale(Math.min(100, Math.max(0, axis.value)))),
  );

  const summary = axes.map((axis) => `${axis.label} ${Math.round(axis.value)}`).join(', ');

  return (
    <figure className="flex flex-col items-center">
      {count >= RADAR_MIN_AXES ? (
        <svg
          role="img"
          aria-label={`${title}. ${summary}.`}
          // Padded well beyond the 100-unit radius: the axis labels live outside
          // the grid and the longest of them ("Maintainability") needs the room.
          viewBox="-175 -148 350 296"
          className="h-auto w-full max-w-[420px]"
        >
          {RADAR_RINGS.map((ring) => (
            <polygon
              key={ring}
              points={toPath(axes.map((_, index) => radarPoint(index, count, scale(ring))))}
              fill="none"
              stroke="oklch(1 0 0 / 8%)"
              strokeWidth={1}
            />
          ))}

          {axes.map((axis, index) => {
            const outer = radarPoint(index, count, RADAR_RADIUS);
            return (
              <line
                key={axis.label}
                x1={0}
                y1={0}
                x2={outer.x}
                y2={outer.y}
                stroke="oklch(1 0 0 / 8%)"
                strokeWidth={1}
              />
            );
          })}

          <polygon
            points={toPath(vertices)}
            fill="var(--color-jade)"
            fillOpacity={0.18}
            stroke="var(--color-jade)"
            strokeWidth={1.75}
            strokeLinejoin="round"
          />

          {vertices.map((vertex, index) => (
            <circle
              key={axes[index]?.label ?? index}
              cx={vertex.x}
              cy={vertex.y}
              r={3}
              fill="var(--color-jade)"
            />
          ))}

          {axes.map((axis, index) => {
            const anchorPoint = radarPoint(index, count, RADAR_RADIUS + 14);
            // Anchoring by horizontal position keeps labels from crossing the
            // grid: left-hand labels grow leftwards, right-hand ones rightwards.
            const anchor = anchorPoint.x > 1 ? 'start' : anchorPoint.x < -1 ? 'end' : 'middle';
            const words = axis.label.split(' ');

            return (
              <text
                key={axis.label}
                x={anchorPoint.x}
                y={anchorPoint.y}
                textAnchor={anchor}
                dominantBaseline="middle"
                fill="var(--color-ink-subtle)"
                style={{ fontSize: 11 }}
              >
                {words.map((word, wordIndex) => (
                  <tspan
                    key={word}
                    x={anchorPoint.x}
                    dy={wordIndex === 0 ? -((words.length - 1) * 6) : 12}
                  >
                    {word}
                  </tspan>
                ))}
                <tspan
                  x={anchorPoint.x}
                  dy={12}
                  fill="var(--color-ink-faint)"
                  style={{ fontVariantNumeric: 'tabular-nums' }}
                >
                  {Math.round(axis.value)}
                </tspan>
              </text>
            );
          })}
        </svg>
      ) : null}

      {/* Text equivalent. Always rendered — it is the only version of this
          chart that exists for a screen reader, and the whole chart when
          there are too few axes to draw a polygon. */}
      <figcaption className={count >= RADAR_MIN_AXES ? 'sr-only' : 'w-full'}>
        <table className="w-full text-sm">
          <caption className="text-ink-subtle mb-2 text-left text-sm">{title}</caption>
          <thead>
            <tr>
              <th scope="col" className="text-ink-muted py-1 text-left font-medium">
                Dimension
              </th>
              <th scope="col" className="text-ink-muted py-1 text-right font-medium">
                {valueHeading}
              </th>
            </tr>
          </thead>
          <tbody>
            {axes.map((axis) => (
              <tr key={axis.label}>
                <th scope="row" className="text-ink-muted py-1 text-left font-normal">
                  {axis.label}
                </th>
                <td className="text-ink py-1 text-right tabular-nums">{Math.round(axis.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </figcaption>
    </figure>
  );
}

// ---------------------------------------------------------------------------
// Language bar
// ---------------------------------------------------------------------------

/**
 * Beyond ten rows the legend stops being scannable and becomes a directory
 * listing. The bar still shows every language — only the legend is capped, and
 * the remainder is counted out loud rather than silently dropped.
 */
const LEGEND_LIMIT = 10;

export interface LanguageBarProps {
  languages: readonly LanguageBreakdown[];
}

export function LanguageBar({ languages }: LanguageBarProps) {
  if (languages.length === 0) {
    return (
      <p className="text-ink-subtle text-sm">
        No source languages were recognised in the analyzed files.
      </p>
    );
  }

  const shown = languages.slice(0, LEGEND_LIMIT);
  const hidden = languages.length - shown.length;
  const summary = languages
    .slice(0, 5)
    .map((language) => `${language.language} ${language.percent}%`)
    .join(', ');

  return (
    <div>
      {/* Flex-grow rather than percentage widths: the `percent` values are
          rounded per language and need not sum to exactly 100, so absolute
          widths would leave a sliver of gap or overflow the track. */}
      <div
        role="img"
        aria-label={`Language breakdown by bytes: ${summary}${hidden > 0 ? `, and ${hidden} more` : ''}.`}
        className="border-line bg-surface flex h-2.5 w-full overflow-hidden rounded-full border"
      >
        {languages.map((language) => (
          <span
            key={language.language}
            className="h-full first:rounded-l-full last:rounded-r-full"
            style={{
              flexGrow: Math.max(language.percent, 0.01),
              flexBasis: 0,
              minWidth: 2,
              backgroundColor: language.color,
            }}
          />
        ))}
      </div>

      <ul className="mt-4 grid gap-x-6 gap-y-2 sm:grid-cols-2">
        {shown.map((language) => (
          <li
            key={language.language}
            className="border-line/70 flex items-baseline gap-2 border-b pb-2 text-sm"
          >
            <span
              aria-hidden="true"
              className="size-2.5 shrink-0 translate-y-px rounded-sm"
              style={{ backgroundColor: language.color }}
            />
            <span className="text-ink min-w-0 flex-1 truncate">{language.language}</span>
            <span className="text-ink tabular-nums">{language.percent}%</span>
            <span className="text-ink-faint w-28 text-right text-xs tabular-nums">
              {formatCount(language.files)} {language.files === 1 ? 'file' : 'files'} ·{' '}
              {formatBytes(language.bytes)}
            </span>
          </li>
        ))}
      </ul>

      {hidden > 0 ? (
        <p className="text-ink-faint mt-3 text-xs">
          {formatCount(hidden)} further {hidden === 1 ? 'language accounts' : 'languages account'}{' '}
          for the remainder of the bar.
        </p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Distribution bars
// ---------------------------------------------------------------------------

export interface DistributionBarsProps {
  data: readonly { readonly bucket: string; readonly count: number }[];
  /** Accessible name for the chart. */
  title: string;
  /** Header for the bucket column in the text equivalent. */
  bucketHeading?: string;
  className?: string;
}

const DIST_WIDTH = 360;
const DIST_HEIGHT = 160;
const DIST_BOTTOM = 22;
const DIST_TOP = 16;

export function DistributionBars({
  data,
  title,
  bucketHeading = 'Bucket',
  className,
}: DistributionBarsProps) {
  const peak = max(data, (datum) => datum.count) ?? 0;

  if (data.length === 0 || peak === 0) {
    return (
      <p className={cn('text-ink-subtle text-sm', className)}>
        No files were measured, so there is no distribution to plot.
      </p>
    );
  }

  const x = scaleBand()
    .domain(data.map((datum) => datum.bucket))
    .range([0, DIST_WIDTH])
    .padding(0.28);

  const y = scaleLinear()
    .domain([0, peak])
    .range([DIST_HEIGHT - DIST_BOTTOM, DIST_TOP])
    // Linear, not log: the buckets are already logarithmic in width (1-5,
    // 6-10, 11-20, 21-50, 50+), so a log height scale would flatten the very
    // contrast the chart exists to show.
    .nice();

  const summary = data.map((datum) => `${datum.bucket}: ${datum.count}`).join(', ');
  const total = data.reduce((sum, datum) => sum + datum.count, 0);

  return (
    <figure className={className}>
      <svg
        role="img"
        aria-label={`${title}. ${summary}.`}
        viewBox={`0 0 ${DIST_WIDTH} ${DIST_HEIGHT}`}
        className="h-auto w-full"
      >
        <line
          x1={0}
          y1={DIST_HEIGHT - DIST_BOTTOM}
          x2={DIST_WIDTH}
          y2={DIST_HEIGHT - DIST_BOTTOM}
          stroke="oklch(1 0 0 / 10%)"
          strokeWidth={1}
        />

        {data.map((datum) => {
          const left = x(datum.bucket);
          if (left === undefined) return null; // scaleBand returns undefined off-domain

          const top = y(datum.count);
          const height = Math.max(0, DIST_HEIGHT - DIST_BOTTOM - top);
          const share = datum.count / peak;

          return (
            <g key={datum.bucket}>
              <rect
                x={left}
                y={top}
                width={x.bandwidth()}
                height={height}
                rx={3}
                // The busiest bucket is the story; the rest recede. Opacity, not
                // hue, so the chart stays a single-colour object.
                fill="var(--color-jade)"
                fillOpacity={0.35 + share * 0.55}
              />
              {datum.count > 0 ? (
                <text
                  x={left + x.bandwidth() / 2}
                  y={top - 4}
                  textAnchor="middle"
                  fill="var(--color-ink-muted)"
                  style={{ fontSize: 10, fontVariantNumeric: 'tabular-nums' }}
                >
                  {datum.count}
                </text>
              ) : null}
              <text
                x={left + x.bandwidth() / 2}
                y={DIST_HEIGHT - 6}
                textAnchor="middle"
                fill="var(--color-ink-faint)"
                style={{ fontSize: 10 }}
              >
                {datum.bucket}
              </text>
            </g>
          );
        })}
      </svg>

      <figcaption className="sr-only">
        <table>
          <caption>{title}</caption>
          <thead>
            <tr>
              <th scope="col">{bucketHeading}</th>
              <th scope="col">Files</th>
            </tr>
          </thead>
          <tbody>
            {data.map((datum) => (
              <tr key={datum.bucket}>
                <th scope="row">{datum.bucket}</th>
                <td>{datum.count}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">Total</th>
              <td>{total}</td>
            </tr>
          </tfoot>
        </table>
      </figcaption>
    </figure>
  );
}
