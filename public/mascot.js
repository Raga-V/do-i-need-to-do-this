// Lazy — the couch-potato mascot for "Do I Need to Do This?"
// Usage: import { lazy, lazyFace } from './mascot.js';  el.innerHTML = lazy('skip', 200);
// Moods: 'chill' (home), 'thinking' (asking), 'skip', 'min', 'later', 'do', 'unsure'
const C = { body: '#D7A56B', light: '#ECC896', shade: '#B98549', dirt: '#8C5E30', line: '#2E241C', blush: '#FF9AA8',
  couch: '#7C6CF2', couchDark: '#5E4ED6', seat: '#9488FA', pillow: '#FFD166', pillowDark: '#F2B33D', alert: '#FF5A5F', accent: '#7C6CF2', sky: '#5BB8FF' };
const L = C.line, W = `stroke="${L}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"`;
const T = (w = 5) => `stroke="${L}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" fill="none"`;
const shades = (y = 100, tilt = 0) => `<g transform="rotate(${tilt} 120 ${y})"><path d="M78 ${y - 2}h84" ${T(5)}/>
  <rect x="80" y="${y - 10}" width="34" height="24" rx="10" fill="#26232F" ${W}/><rect x="126" y="${y - 10}" width="34" height="24" rx="10" fill="#26232F" ${W}/>
  <path d="M87 ${y - 4}l8 -2M133 ${y - 4}l8 -2" stroke="#fff" stroke-width="3.5" stroke-linecap="round" opacity=".85"/></g>`;
const eye = (x, y, r = 8) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${L}"/><circle cx="${x + r * .35}" cy="${y - r * .35}" r="${r * .38}" fill="#fff"/>`;
const hand = (x, y) => `<circle cx="${x}" cy="${y}" r="6" fill="${C.body}" ${W}/>`;

const face = (mood) => ({
  chill:    shades(100) + `<path d="M110 124q10 8 22 -2" ${T()}/>`,
  thinking: shades(66, -6) + eye(104, 104) + eye(136, 104) + `<circle cx="120" cy="124" r="4" fill="${L}"/>`,
  skip:     `<rect x="80" y="90" width="80" height="22" rx="11" fill="#4B4691" ${W}/><path d="M92 101q7 5 14 0M134 101q7 5 14 0" stroke="#fff" stroke-width="3.5" fill="none" stroke-linecap="round"/><ellipse cx="120" cy="128" rx="6" ry="7.5" fill="${L}"/><ellipse cx="120" cy="131" rx="3.6" ry="3" fill="#FF7A8A"/>`,
  min:      shades(108) + `<path d="M108 128q12 5 24 -3" ${T()}/>`,
  later:    shades(80) + eye(104, 108) + `<path d="M128 109q8 -8 16 0" ${T()}/><path d="M108 122q12 13 24 0z" fill="#8A3B2F" ${W}/>`,
  do:       `<circle cx="104" cy="104" r="13" fill="#fff" ${W}/><circle cx="138" cy="104" r="13" fill="#fff" ${W}/><circle cx="104" cy="106" r="5.5" fill="${L}"/><circle cx="138" cy="106" r="5.5" fill="${L}"/><ellipse cx="121" cy="130" rx="8" ry="10" fill="${L}"/>`,
  unsure:   shades(112) + eye(104, 92, 7) + eye(138, 89, 7) + `<path d="M94 78l18 4M128 76l20 -6" ${T()}/><path d="M108 132q6 -6 12 0t12 0" ${T()}/>`,
}[mood] || '');

/** The potato itself: body, shading, blush and the mood's face. */
const potato = (mood) => `<path d="M120 44C152 44 170 72 168 108C167 126 172 138 170 156C167 178 148 192 120 192C92 192 73 180 70 158C68 140 74 128 72 110C70 74 88 44 120 44Z" fill="${C.body}" ${W}/>
  <path d="M90 66c8-10 20-15 32-15" stroke="${C.light}" stroke-width="8" stroke-linecap="round" fill="none"/>
  <path d="M156 100C162 124 160 160 138 182C152 160 158 132 156 100Z" fill="${C.shade}" opacity=".35"/>
  <path d="M148 70q5 -4 9 1M84 146q4 -4 8 0M150 166q5 -4 9 1M106 176q4 -3 8 1" stroke="${C.dirt}" stroke-width="3.5" stroke-linecap="round" fill="none"/>
  <circle cx="134" cy="58" r="2.6" fill="${C.shade}"/><circle cx="160" cy="140" r="2.4" fill="${C.shade}"/><circle cx="82" cy="128" r="2.4" fill="${C.shade}"/><circle cx="96" cy="80" r="2" fill="${C.shade}"/>
  <ellipse cx="92" cy="124" rx="9" ry="6" fill="${C.blush}" opacity=".75"/><ellipse cx="150" cy="124" rx="9" ry="6" fill="${C.blush}" opacity=".75"/>
  ${face(mood)}`;

/** Just Lazy's head-and-body (no couch, arms or props) for small spots: the logo, the favicon, inline notes. Decorative. */
export function lazyFace(mood = 'chill', size = 24) {
  return `<svg class="lazy-face" width="${Math.round(size * 112 / 158)}" height="${size}" viewBox="64 38 112 158" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${potato(mood)}</svg>`;
}

export function lazy(mood = 'chill', size = 200) {
  const spread = `<path d="M76 118q-24 -6 -36 -24" ${T()}/>${hand(39, 92)}<path d="M164 118q24 -6 36 -24" ${T()}/>${hand(201, 92)}`;
  const ARMS = {
    chill: spread, skip: spread,
    thinking: `<path d="M76 120q-22 4 -30 -12" ${T()}/>${hand(45, 106)}<path d="M164 128q18 -2 10 -18q-6 -8 -16 -4" ${T()}/>${hand(156, 106)}`,
    min:   `<path d="M76 118q-24 -6 -36 -24" ${T()}/>${hand(39, 92)}<path d="M164 132q14 0 20 -10" ${T()}/>`,
    later: `<path d="M76 118q-24 -6 -36 -24" ${T()}/>${hand(39, 92)}<path d="M164 124q18 -4 20 -24" ${T()}/>`,
    do:    `<path d="M76 116q-20 -14 -24 -38" ${T()}/>${hand(52, 76)}<path d="M164 116q20 -14 24 -38" ${T()}/>${hand(188, 76)}`,
    unsure:`<path d="M76 122q-20 4 -26 18" ${T()}/>${hand(50, 142)}<path d="M164 120q22 -4 22 -22" ${T()}/>${hand(186, 96)}`,
  }[mood] || '';

  const LEGS = {
    chill: `<path d="M104 186q-2 16 -12 24" ${T()}/><path d="M136 186q16 4 8 12q-10 6 -24 2" ${T()}/><ellipse cx="88" cy="213" rx="9" ry="5.5" fill="${L}"/><ellipse cx="117" cy="200" rx="9" ry="5.5" fill="${L}"/>`,
    do:    `<path d="M106 186v24M134 186v24" ${T()}/><ellipse cx="102" cy="213" rx="10" ry="5.5" fill="${L}"/><ellipse cx="138" cy="213" rx="10" ry="5.5" fill="${L}"/>`,
  }[mood] || `<path d="M104 186q-2 16 -8 24M136 186q2 16 8 24" ${T()}/><ellipse cx="93" cy="213" rx="9" ry="5.5" fill="${L}"/><ellipse cx="147" cy="213" rx="9" ry="5.5" fill="${L}"/>`;

  const PROPS = {
    chill:    `<g transform="translate(176 150) rotate(-20)"><rect width="16" height="34" rx="6" fill="#4A4A5A" ${W}/><circle cx="8" cy="9" r="3" fill="${C.alert}"/><circle cx="8" cy="19" r="2.2" fill="#fff"/><circle cx="8" cy="26" r="2.2" fill="#fff"/></g><g class="lz-float"><path d="M196 40l4 10 10 4 -10 4 -4 10 -4 -10 -10 -4 10 -4z" fill="#FFC53D"/><path d="M178 66l2 5 5 2 -5 2 -2 5 -2 -5 -5 -2 5 -2z" fill="#FFC53D"/></g>`,
    thinking: `<g class="lz-float"><circle cx="196" cy="44" r="18" fill="#fff" ${W}/><text x="188" y="53" font-size="24" font-weight="900" fill="${C.accent}" font-family="system-ui,sans-serif">?</text><circle cx="176" cy="68" r="5" fill="#fff" ${W}/></g>`,
    skip:     `<g class="lz-zzz" font-family="system-ui,sans-serif" font-weight="900" fill="${C.accent}" stroke="#fff" stroke-width="2" paint-order="stroke"><text x="166" y="66" font-size="20">z</text><text x="182" y="48" font-size="26">z</text><text x="200" y="28" font-size="32">Z</text></g>`,
    min:      `<g transform="translate(182 106)"><rect width="24" height="26" rx="6" fill="#fff" ${W}/><path d="M24 7q10 0 10 8t-10 8" ${T(4)}/><path d="M7 -5q4 -6 0 -12M16 -5q4 -6 0 -12" stroke="#B8B0D0" stroke-width="3" fill="none" stroke-linecap="round"/></g>`,
    later:    `<g transform="translate(172 60) rotate(12)"><rect width="40" height="42" rx="9" fill="#fff" ${W}/><rect x="2.5" y="2.5" width="35" height="10" rx="5" fill="${C.alert}"/><text x="9" y="35" font-size="18" font-weight="900" fill="${L}" font-family="system-ui,sans-serif">26</text></g>`,
    do:       `<g transform="translate(150 22) rotate(25)"><rect width="22" height="16" rx="7" fill="#26232F" ${W}/><rect x="28" width="22" height="16" rx="7" fill="#26232F" ${W}/><path d="M22 6h6" ${T(4)}/></g><path d="M166 94q7 11 0 17q-7 -6 0 -17z" fill="${C.sky}" ${W}/><g font-family="system-ui,sans-serif" font-weight="900" fill="${C.alert}" stroke="#fff" stroke-width="2" paint-order="stroke"><text x="34" y="58" font-size="34">!</text></g>`,
    unsure:   `<g class="lz-float" font-family="system-ui,sans-serif" font-weight="900" fill="${C.accent}" stroke="#fff" stroke-width="2" paint-order="stroke"><text x="184" y="62" font-size="32">?</text><text x="30" y="70" font-size="22">?</text></g>`,
  }[mood] || '';

  const lift = mood === 'do' ? -14 : 0;
  const tilt = mood === 'skip' ? 10 : mood === 'unsure' ? -7 : mood === 'chill' ? -4 : 0;
  return `<svg class="lazy lazy-${mood}" width="${size}" height="${size}" viewBox="0 0 240 240" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Lazy the couch potato (${mood})">
<style>.lazy .lz-body{animation:lzb 3.4s ease-in-out infinite;transform-box:fill-box;transform-origin:50% 100%}@keyframes lzb{50%{transform:scale(1.02,.98)}}
.lazy-do .lz-body{animation:lzj .45s ease-in-out infinite}@keyframes lzj{50%{transform:translateY(-5px)}}
.lazy .lz-float{animation:lzf 2.8s ease-in-out infinite}@keyframes lzf{50%{transform:translateY(-6px)}}
.lazy .lz-zzz text{opacity:0;animation:lzz 2.6s ease-in-out infinite}.lazy .lz-zzz text:nth-child(2){animation-delay:.55s}.lazy .lz-zzz text:nth-child(3){animation-delay:1.1s}
@keyframes lzz{25%,70%{opacity:1}100%{opacity:0;transform:translate(8px,-12px)}}@media (prefers-reduced-motion:reduce){.lazy *{animation:none!important}}</style>
<ellipse cx="120" cy="226" rx="100" ry="8" fill="#000" opacity=".07"/>
<rect x="34" y="74" width="172" height="112" rx="34" fill="${C.couchDark}" ${W}/>
<g transform="rotate(-14 66 132)"><rect x="46" y="112" width="40" height="40" rx="12" fill="${C.pillow}" ${W}/><path d="M60 126l12 12M72 126l-12 12" stroke="${C.pillowDark}" stroke-width="4" stroke-linecap="round"/></g>
<g transform="rotate(14 174 132)"><rect x="154" y="112" width="40" height="40" rx="12" fill="${C.pillow}" ${W}/><path d="M168 126l12 12M180 126l-12 12" stroke="${C.pillowDark}" stroke-width="4" stroke-linecap="round"/></g>
<rect x="44" y="170" width="152" height="40" rx="14" fill="${C.seat}" ${W}/>
<rect x="12" y="130" width="44" height="80" rx="20" fill="${C.couch}" ${W}/><rect x="184" y="130" width="44" height="80" rx="20" fill="${C.couch}" ${W}/>
<rect x="30" y="208" width="12" height="12" rx="3" fill="${L}"/><rect x="198" y="208" width="12" height="12" rx="3" fill="${L}"/>
<g transform="translate(0 ${lift}) rotate(${tilt} 120 180)"><g class="lz-body">
  ${ARMS}
  ${potato(mood)}
  ${LEGS}
</g></g>
${PROPS}
</svg>`;
}
export const spud = lazy; // old name still works
