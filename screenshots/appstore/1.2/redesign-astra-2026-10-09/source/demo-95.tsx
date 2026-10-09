/** Marketing sample, explicitly requested by the owner. No live data is changed.
 * Uses the production scoring engine, ScoreWheel SVG and safety assessment.
 * The small HTML card shell is transcribed to SVG with the same Tailwind
 * dimensions/colors so exports do not require a browser or computer access.
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import fs from 'node:fs';
import path from 'node:path';
import { ScoreWheel } from '@/components/ScoreWheel';
import { SafetyLine } from '@/components/plus/SafetyLine';
import { scoreBeachDay, SCORING_ENGINE_VERSION, type Derived } from '@/lib/score';
import { swimSafety } from '@/lib/safetyLine';
import type { ConditionsSnapshot } from '@/lib/types';

export const derived: Derived = {
  airTempF:84, waterTempF:82, windSpeedMph:8, windDirDeg:90,
  cloudCoverPct:10, precipProbability:0, shortForecast:'Sunny', weatherCode:0,
  dewPointF:69, humidityPct:61, waveHeightFt:1.4,
  sargassumLevel:'low', sargassumCoveragePct:6, crowdPct:25,
  uvIndex:5, sandTempF:101,
  flags:['green'], waterAdvisory:false, waterRating:'good',
  noSwimAdvisory:false, ripCurrentRisk:'low',
  ripNow:{level:'low', source:'forecast', alert:null, upcomingAlert:null,
    period:{level:'low',periodLabel:'Sample day'}, model:null, watch:false},
  severeAlert:false, surfAdvisory:false, highSurfAdvisory:false,
  nowcastRaining:false, lightningWithin5mi:false,
};
export function build(outDir: string) {
  const score = scoreBeachDay(derived);
  const safety = swimSafety(derived);
  if (score.score!==95 || score.subScores.some(s=>(s.score??0)<90) || safety.level!=='safe')
    throw Error('Demo must calculate 95, all emerald slices, and safe swim status.');
  const wheelHtml = renderToStaticMarkup(<ScoreWheel result={score}/>);
  const safetyHtml = renderToStaticMarkup(<SafetyLine derived={derived} snapshot={{} as ConditionsSnapshot} profile={null}/>);
  let wheel = wheelHtml.match(/<svg[\s\S]*?<\/svg>/)![0];
  wheel=wheel.replace('<svg ', '<svg x="96" y="176" width="978" height="978" ');
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="1170" height="1530" viewBox="0 0 1170 1530">
    <style>text{font-family:Helvetica Neue,Arial,sans-serif}.fill-slate-600{fill:#475569}</style>
    <rect width="1170" height="1530" fill="#f3f7fb"/>
    <text x="48" y="79" font-size="54" font-weight="600" fill="#0f172a">What's making the score</text>
    <rect x="48" y="128" width="1074" height="1146" rx="48" fill="#fff" fill-opacity=".8" stroke="#0f172a" stroke-opacity=".1" stroke-width="3"/>
    ${wheel}
    <text x="585" y="1213" text-anchor="middle" font-size="33" fill="#94a3b8">tap a slice to see how it's calculated and what it's worth</text>
    <rect x="48" y="1310" width="1074" height="168" rx="48" fill="#10b981" fill-opacity=".1" stroke="#10b981" stroke-opacity=".25" stroke-width="3"/>
    <circle cx="118" cy="1394" r="23" fill="#10b981"/>
    <text x="184" y="1410" font-size="42" font-weight="600" fill="#065f46">Swim safety: Safe</text>
  </svg>`;
  fs.writeFileSync(path.join(outDir,'assets/01-app-95-demo.svg'),svg);
  fs.writeFileSync(path.join(outDir,'source/demo-95-native.html'),wheelHtml+safetyHtml);
  fs.writeFileSync(path.join(outDir,'source/demo-95-state.json'),JSON.stringify({
    type:'illustrative marketing sample, not a live observation',
    scoringEngine:SCORING_ENGINE_VERSION, derived, score, safety,
    productionComponents:['components/ScoreWheel.tsx','components/plus/SafetyLine.tsx'],
    renderMethod:'Production React ScoreWheel SVG; vector card shell matching app typography and colors',
  },null,2)+'\n');
  return svg;
}
