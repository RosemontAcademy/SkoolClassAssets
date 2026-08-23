#!/usr/bin/env node
/**
 * Generate SkillFX assets for SpellRaid via PixelLab API.
 *
 * Order per character:
 *   1. attack-fx.gif   — student attacks boss  (NE, animate-with-text-v2)
 *   2. attacked-fx.gif — boss attacks student  (SW, animate-with-text-v2)
 *   3. hit-fx.gif      — post-impact flash     (animate-with-text, free)
 *
 * Output:
 *   SkoolClassAssets/skillFX/{character}/attack-fx.gif
 *   SkoolClassAssets/skillFX/{character}/attacked-fx.gif
 *   SkoolClassAssets/skillFX/{character}/hit-fx.gif
 *
 * Usage:
 *   node generate_skill_fx.mjs bulbasaur
 *   node generate_skill_fx.mjs --all
 *   node generate_skill_fx.mjs bulbasaur --step attack
 *   node generate_skill_fx.mjs bulbasaur --step attacked
 *   node generate_skill_fx.mjs bulbasaur --step hit
 *   node generate_skill_fx.mjs --list
 */

import { mkdirSync, existsSync, createWriteStream, readdirSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { Jimp, JimpMime, ResizeStrategy } = require('jimp');
const GifEncoder = require('gif-encoder-2');

const __dirname = dirname(fileURLToPath(import.meta.url));
const ASSETS_ROOT  = join(__dirname, '..');
const SPRITES_BACK  = join(ASSETS_ROOT, 'sprites', 'pokemon', 'other', 'showdown', 'back');
const SPRITES_FRONT = join(ASSETS_ROOT, 'sprites', 'pokemon', 'other', 'showdown');
const OUTPUT_DIR   = join(ASSETS_ROOT, 'skillFX');

const API_KEY  = process.env.PIXELLAB_API_KEY ?? '';
const BASE_URL = 'https://api.pixellab.ai/v2';

// ---------------------------------------------------------------------------
// Character configs
// canvas_size: sprite × ~2.5 (max 320 for Tier 1)
// ---------------------------------------------------------------------------
const CHARACTERS = {
  // Bulbasaur line — Vine Whip / Razor Leaf / Solar Beam
  bulbasaur: {
    spriteId: 1, canvasSize: 128,
    attackAction:  'character sits at bottom-left corner of canvas facing right, extends two green vines from the bulb on its back stretching diagonally toward the top-right corner of the canvas, vines arc upward-right, side view, pixel art, transparent background',
    attackedAction:'character sits at top-right corner of canvas facing the viewer, extends two green vines from the bulb on its back stretching diagonally toward the bottom-left corner, vines arc downward-left, front view, pixel art, transparent background',
    hitColor: 0x3DA83DFF, hitShape: 'horizontal', elemental: false,
    hitDescription: 'vine whip horizontal slash impact, a thick green vine cracks sharply across the frame like a whip lash, plant fibers tear and splinter sideways, green energy discharge crackles along the crack line, torn leaves fly left and right, pixel art',
    hitAction: 'vine cracks horizontally with a sharp slash motion, fiber shreds and leaf fragments fly sideways in both directions, gravity pulls them downward in arcs then they fade',
  },
  ivysaur: {
    spriteId: 2, canvasSize: 128,
    attackAction:  'character sits at bottom-left corner of canvas facing right, launches a volley of sharp spinning leaves from the bulb on its back flying diagonally toward the top-right corner, leaves arc upward-right, side view, pixel art, transparent background',
    attackedAction:'character sits at top-right corner of canvas facing the viewer, launches sharp spinning leaves from the bulb flying diagonally toward the bottom-left corner, leaves arc downward-left, front view, pixel art, transparent background',
    hitColor: 0x7BC441FF, hitShape: 'scatter', elemental: false,
    hitDescription: 'razor leaf multi-hit scatter, multiple sharp leaf blades slice into the target from different angles simultaneously, each impact point flashes a cutting line, shredded leaf fragments spin independently in separate directions, lime green and dark green tones, pixel art',
    hitAction: 'leaf blades strike from scattered multiple angles at once, each cut mark flashes individually then shredded leaf shards spin away tumbling in separate trajectories and fade',
  },
  venusaur: {
    spriteId: 3, canvasSize: 256,
    attackAction:  'character sits at bottom-left corner of canvas facing right, fires a thick bright yellow-green energy beam from the flower on its back shooting diagonally toward the top-right corner, beam fills upper-right of canvas, side view, pixel art, transparent background',
    attackedAction:'character sits at top-right corner of canvas facing the viewer, fires a thick bright yellow-green energy beam from the flower shooting diagonally toward the bottom-left corner, beam fills lower-left of canvas, front view, pixel art, transparent background',
    hitColor: 0xE8FF44FF, hitShape: 'star', elemental: true,
    hitDescription: 'solar beam star burst detonation, a blinding white-yellow light explosion erupts into sharp straight rays shooting outward like a compass rose, eight distinct light beams extend from the center point, intense sparkle particles dot each beam, pixel art',
    hitAction: 'eight sharp light rays shoot outward simultaneously from center in star formation, rays extend to full length then fade from tips inward leaving an afterglow pulse that dims to nothing',
  },
  // Charmander line — Ember / Flamethrower / Fire Blast
  charmander: {
    spriteId: 4, canvasSize: 128,
    attackAction:  'character stands at bottom-left corner of canvas facing right, spits small glowing orange ember sparks from its mouth arcing diagonally toward the top-right corner, sparks trail upward-right, side view, pixel art, transparent background',
    attackedAction:'character stands at top-right corner of canvas facing the viewer, spits small glowing orange ember sparks from its mouth arcing diagonally toward the bottom-left corner, sparks trail downward-left, front view, pixel art, transparent background',
    hitColor: 0xFF6B1AFF, hitShape: 'scatter', elemental: true,
    hitDescription: 'ember scatter impact, several small individual orange-red cinders hit separate spots simultaneously, each tiny spark bounces and rolls independently on the ground, small flame puffs briefly ignite where each cinder lands then cool to grey ash, scattered points of orange light, pixel art',
    hitAction: 'individual cinders bounce from separate impact points, each rolls and tumbles independently in a different direction, dims and cools to grey one by one then disappears',
  },
  charmeleon: {
    spriteId: 5, canvasSize: 128,
    attackAction:  'character stands at bottom-left corner of canvas facing right, breathes a continuous stream of orange-red fire from its mouth shooting diagonally toward the top-right corner, flame jet extends to upper-right of canvas, side view, pixel art, transparent background',
    attackedAction:'character stands at top-right corner of canvas facing the viewer, breathes a continuous stream of orange-red fire from its mouth shooting diagonally toward the bottom-left corner, flame jet extends to lower-left of canvas, front view, pixel art, transparent background',
    hitColor: 0xFF3300FF, hitShape: 'vertical', elemental: true,
    hitDescription: 'flamethrower vertical column impact, intense orange-red fire erupts upward from the hit point in a tall billowing column, flames curl and roll upward on both sides, thick black smoke rises from the top, burning embers fall back down along the edges, heat shimmer wavy lines radiate sideways, pixel art',
    hitAction: 'fire column erupts upward from ground level, flames billow and roll up to full height, then burn out from bottom upward leaving a rising smoke column that thins and fades',
  },
  charizard: {
    spriteId: 6, canvasSize: 256,
    attackAction:  'charizard seen from behind with two wings, already facing the top-right corner, body held still with no turning, a giant plus-shaped fire blast builds and erupts toward the top-right: a vertical flame pillar crossed by a horizontal flame bar forming a symmetrical fire cross, orange-red edges, side view, pixel art, transparent background',
    attackedAction:'charizard with exactly two wings, one wing on each side, at top-right of canvas facing the viewer, breathes a giant plus-shaped fire blast toward the bottom-left corner: a vertical flame pillar crossed by a horizontal flame bar forming a symmetrical fire cross, orange-red edges, front view, pixel art, transparent background',
    hitColor: 0xFFAA00FF, hitShape: 'cross', elemental: true,
    hitDescription: 'fire blast giant cross detonation, a tall blazing vertical fire pillar and a wide horizontal fire bar erupt and intersect at the center forming a huge symmetrical plus-shaped fiery cross, brilliant yellow-white core, orange-red flames roil along each of the four arms, sparks and embers spray outward from the four blazing tips, pixel art',
    hitAction: 'the four flame arms of the cross erupt outward from the center simultaneously to full length, blaze at peak intensity, then burn out from the tips inward as embers scatter and fade',
  },
  // Squirtle line — Water Gun / Water Pulse / Hydro Pump
  squirtle: {
    spriteId: 7, canvasSize: 128,
    attackAction:  'character stands at bottom-left corner of canvas facing right, shoots a straight jet of water from its mouth diagonally toward the top-right corner, cyan water beam extends to upper-right of canvas, side view, pixel art, transparent background',
    attackedAction:'character stands at top-right corner of canvas facing the viewer, shoots a straight jet of water from its mouth diagonally toward the bottom-left corner, cyan water beam extends to lower-left of canvas, front view, pixel art, transparent background',
    hitColor: 0x33CCFFFF, hitShape: 'vertical', elemental: true,
    hitDescription: 'water gun vertical splash impact, a high-pressure water jet strikes and erupts upward in a tall fountain column, white spray fans out at the top like an exploding geyser, heavy water droplets arc outward and fall back down following gravity, aqua and white tones, pixel art',
    hitAction: 'water column shoots upward from impact point like a geyser, fans into arcing droplets at the top, each droplet follows its own gravity arc downward then fades on landing',
  },
  wartortle: {
    spriteId: 8, canvasSize: 128,
    attackAction:  'character stands at bottom-left corner of canvas facing right, fires a glowing cyan ring of water energy from its mouth traveling diagonally toward the top-right corner, ring expands as it moves upper-right, side view, pixel art, transparent background',
    attackedAction:'character stands at top-right corner of canvas facing the viewer, fires a glowing cyan ring of water energy from its mouth traveling diagonally toward the bottom-left corner, ring expands as it moves lower-left, front view, pixel art, transparent background',
    hitColor: 0x0099CCFF, hitShape: 'ring', elemental: true,
    hitDescription: 'water pulse concentric ring shockwave, a glowing cyan ring shatters on impact and releases three expanding concentric ripple rings in sequence, each ring glows brighter at its edge as it expands, water droplets are swept outward riding each wave, pixel art',
    hitAction: 'first ring expands rapidly outward from center, second and third rings follow in sequence each slightly slower, droplets ride the outermost ring then fall, all rings fade from outer edge inward',
  },
  blastoise: {
    spriteId: 9, canvasSize: 256,
    attackAction:  'character stands at bottom-left corner of canvas facing right, fires two powerful water jets from the cannons on its shoulders shooting diagonally toward the top-right corner, twin cyan water jets fill upper-right of canvas, side view, pixel art, transparent background',
    attackedAction:'character stands at top-right corner of canvas facing the viewer, fires two powerful water jets from the cannons on its shoulders shooting diagonally toward the bottom-left corner, twin cyan water jets fill lower-left of canvas, front view, pixel art, transparent background',
    hitColor: 0x0055AAFF, hitShape: 'vertical', elemental: true,
    hitDescription: 'hydro pump catastrophic vertical explosion, twin ultra-high-pressure water jets converge and detonate into a massive towering water pillar, an enormous column of blue-white water erupts vertically filling the entire height of the canvas, heavy foam and spray crash outward at the base, ground craters and cracks from sheer hydraulic force, pixel art',
    hitAction: 'massive water pillar erupts to full height instantly, top explodes into heavy cascading sheets that crash down on both sides, base foam spreads outward then entire column collapses downward and drains away',
  },
  // Caterpie line — String Shot / Tackle / Gust
  caterpie: {
    spriteId: 10, canvasSize: 128,
    attackAction:  'caterpie at bottom-left of canvas facing right, shoots a spray of sticky white silk string from its mouth stretching diagonally toward the top-right corner, silk threads trail upper-right, side view, pixel art, transparent background',
    attackedAction:'caterpie at top-right of canvas facing the viewer, shoots a spray of sticky white silk string from its mouth stretching diagonally toward the bottom-left corner, silk threads trail lower-left, front view, pixel art, transparent background',
    hitColor: 0xE8F0C8FF, hitShape: 'scatter', elemental: false,
    hitDescription: 'string shot scatter impact, multiple sticky pale silk threads splatter onto the target from several angles at once, cream and light green strands cling and stretch taut, small soft puffs where each thread sticks, pixel art',
    hitAction: 'silk threads splatter from scattered points, each strand sticks and stretches taut in a different direction, then loosens, droops and fades',
  },
  metapod: {
    spriteId: 11, canvasSize: 128,
    attackAction:  'metapod green hard cocoon seen from behind at bottom-left of canvas, already aimed toward the top-right corner, lunges its whole rigid body straight forward in a body-slam toward the top-right, motion streak lines trail behind, no spinning or turning, side view, pixel art, transparent background',
    attackedAction:'metapod green hard cocoon at top-right of canvas facing the viewer, hurls its whole rigid body forward in a charging body-slam ramming diagonally toward the bottom-left corner, motion streaks trail behind it, front view, pixel art, transparent background',
    hitColor: 0x8BC34AFF, hitShape: 'star', elemental: false,
    hitDescription: 'tackle body slam impact, a hard blunt collision bursts at the hit point with sharp white radiating impact lines shooting outward, dust and shock flecks fly in all directions, faint green tint from the cocoon shell, pixel art',
    hitAction: 'a sharp impact flash bursts outward with radiating lines on collision, dust flecks scatter in all directions then fade quickly',
  },
  butterfree: {
    spriteId: 12, canvasSize: 256,
    attackAction:  'butterfree at bottom-left of canvas facing right with wings spread, flaps its wings to launch a swirling gust of wind blowing diagonally toward the top-right corner, curved wind currents and small particles trail upper-right, side view, pixel art, transparent background',
    attackedAction:'butterfree at top-right of canvas facing the viewer with wings spread, flaps its wings to launch a swirling gust of wind blowing diagonally toward the bottom-left corner, curved wind currents and small particles trail lower-left, front view, pixel art, transparent background',
    hitColor: 0xCFE8F0FF, hitShape: 'horizontal', elemental: false,
    hitDescription: 'gust wind impact, curved horizontal wind slashes sweep across the target, translucent white and pale cyan air currents with small dust particles are blown sideways, crescent wind gusts, pixel art',
    hitAction: 'curved wind gusts sweep horizontally across the frame, particles blow sideways riding the currents then disperse and fade',
  },
  // Weedle line — Poison Sting / Tackle / Twineedle
  weedle: {
    spriteId: 13, canvasSize: 128,
    attackAction:  'weedle at bottom-left of canvas facing right stays fully visible in every frame, repeatedly shooting sharp purple poison needles from the horn on its head toward the top-right corner, needles streak upper-right, the weedle body never leaves the frame, side view, pixel art, transparent background',
    attackedAction:'weedle at top-right of canvas facing the viewer stays fully visible in every frame, repeatedly shooting sharp purple poison needles from the horn on its head toward the bottom-left corner, needles streak lower-left, the weedle body never leaves the frame, front view, pixel art, transparent background',
    hitColor: 0xA040C0FF, hitShape: 'scatter', elemental: true,
    hitDescription: 'poison sting scatter impact, several sharp purple venom needles jab into the target from different angles at once, each puncture point flashes a small purple toxic splash, dark violet droplets scatter, pixel art',
    hitAction: 'venom needles strike from scattered points simultaneously, each jab flashes a purple toxic splash then the droplets scatter and fade',
  },
  kakuna: {
    spriteId: 14, canvasSize: 128,
    attackAction:  'kakuna yellow hard cocoon seen from behind at bottom-left of canvas, already aimed toward the top-right corner, lunges its whole rigid body straight forward in a body-slam toward the top-right, motion streak lines trail behind, no spinning or turning, side view, pixel art, transparent background',
    attackedAction:'kakuna yellow hard cocoon at top-right of canvas facing the viewer, lunges its whole rigid body straight forward in a body-slam toward the bottom-left corner, motion streak lines trail behind, no spinning or turning, front view, pixel art, transparent background',
    hitColor: 0xE8C840FF, hitShape: 'star', elemental: false,
    hitDescription: 'tackle body slam impact, a hard blunt collision bursts at the hit point with sharp white radiating impact lines shooting outward, dust and shock flecks fly in all directions, faint yellow tint from the cocoon shell, pixel art',
    hitAction: 'a sharp impact flash bursts outward with radiating lines on collision, dust flecks scatter in all directions then fade quickly',
  },
  beedrill: {
    spriteId: 15, canvasSize: 256,
    attackAction:  'beedrill at bottom-left of canvas facing right, thrusts its two long sharp arm stingers forward jabbing diagonally toward the top-right corner, twin needle stingers streak upper-right with motion lines, side view, pixel art, transparent background',
    attackedAction:'beedrill at top-right of canvas facing the viewer, thrusts its two long sharp arm stingers forward jabbing diagonally toward the bottom-left corner, twin needle stingers streak lower-left with motion lines, front view, pixel art, transparent background',
    hitColor: 0xE0D040FF, hitShape: 'scatter', elemental: false,
    hitDescription: 'twineedle double jab impact, two sharp stinger needles stab the target in quick succession at two points, each puncture flashes a sharp white and pale yellow burst, small sting sparks scatter, pixel art',
    hitAction: 'two needle jabs strike in rapid succession at two points, each flashes a sharp burst then sparks scatter outward and fade',
  },
  // Pidgey line — Gust / Wing Attack / Hurricane
  pidgey: {
    spriteId: 16, canvasSize: 128,
    attackAction:  'pidgey at bottom-left of canvas facing right stays fully visible in every frame, flaps its wings to send a swirling gust of wind toward the top-right corner, curved wind currents streak upper-right, side view, pixel art, transparent background',
    attackedAction:'pidgey at top-right of canvas facing the viewer stays fully visible in every frame, flaps its wings to send a swirling gust of wind toward the bottom-left corner, curved wind currents streak lower-left, front view, pixel art, transparent background',
    hitColor: 0xCFE8F0FF, hitShape: 'horizontal', elemental: false,
    hitDescription: 'gust wind impact, curved horizontal wind slashes sweep across the target, translucent white and pale cyan air currents with small feathers and dust blown sideways, crescent wind gusts, pixel art',
    hitAction: 'curved wind gusts sweep horizontally across the frame, feathers and particles blow sideways then disperse and fade',
  },
  pidgeotto: {
    spriteId: 17, canvasSize: 128,
    attackAction:  'pidgeotto at bottom-left of canvas facing right stays fully visible in every frame, sweeps its large wing forward in a slashing wing attack toward the top-right corner, sharp white wind slash streaks upper-right, side view, pixel art, transparent background',
    attackedAction:'pidgeotto at top-right of canvas facing the viewer stays fully visible in every frame, sweeps its large wing forward in a slashing wing attack toward the bottom-left corner, sharp white wind slash streaks lower-left, front view, pixel art, transparent background',
    hitColor: 0xE8E0D0FF, hitShape: 'horizontal', elemental: false,
    hitDescription: 'wing attack slash impact, a sharp crescent wing slash cuts horizontally across the target, white and tan wind blades with scattered feathers, sharp cutting lines, pixel art',
    hitAction: 'a sharp crescent wing slash cuts across horizontally, feathers and wind blades scatter sideways then fade',
  },
  pidgeot: {
    spriteId: 18, canvasSize: 256,
    attackAction:  'pidgeot at bottom-left of canvas facing right with wings spread stays fully visible in every frame, whips up a swirling spiraling hurricane of wind toward the top-right corner, powerful curved wind vortex fills upper-right, side view, pixel art, transparent background',
    attackedAction:'pidgeot at top-right of canvas facing the viewer with wings spread stays fully visible in every frame, whips up a swirling spiraling hurricane of wind toward the bottom-left corner, powerful curved wind vortex fills lower-left, front view, pixel art, transparent background',
    hitColor: 0xB8D8E8FF, hitShape: 'ring', elemental: false,
    hitDescription: 'hurricane spiral impact, a powerful swirling vortex of wind rings spins outward from the center, concentric curved wind bands with feathers and debris swept around the spiral, pale cyan and white, pixel art',
    hitAction: 'wind vortex rings spin and expand outward from center in a spiral, feathers and debris swept around then flung outward and fade',
  },
  // Rattata line — Quick Attack / Hyper Fang
  rattata: {
    spriteId: 19, canvasSize: 128,
    attackAction:  'rattata at bottom-left of canvas facing right stays fully visible in every frame, dashes forward in a quick attack lunging toward the top-right corner, sharp white speed streak lines trail upper-right, side view, pixel art, transparent background',
    attackedAction:'rattata at top-right of canvas facing the viewer stays fully visible in every frame, dashes forward in a quick attack lunging toward the bottom-left corner, sharp white speed streak lines trail lower-left, front view, pixel art, transparent background',
    hitColor: 0xF0E8D0FF, hitShape: 'horizontal', elemental: false,
    hitDescription: 'quick attack speed impact, a fast horizontal streak of white speed lines slams into the target, sharp motion blur and impact flash, small dust flecks, pixel art',
    hitAction: 'a fast white speed streak slams across horizontally with an impact flash, dust flecks scatter then fade quickly',
  },
  raticate: {
    spriteId: 20, canvasSize: 128,
    attackAction:  'raticate at bottom-left of canvas facing right stays fully visible in every frame, lunges forward biting with huge sharp fangs toward the top-right corner, white fang slash and impact streak toward upper-right, side view, pixel art, transparent background',
    attackedAction:'raticate at top-right of canvas facing the viewer stays fully visible in every frame, lunges forward biting with huge sharp fangs toward the bottom-left corner, white fang slash and impact streak toward lower-left, front view, pixel art, transparent background',
    hitColor: 0xF0E0C0FF, hitShape: 'scatter', elemental: false,
    hitDescription: 'hyper fang bite impact, two large sharp fang puncture marks flash on the target with a burst, white and tan impact flecks scatter from the bite point, pixel art',
    hitAction: 'two fang puncture flashes burst at the bite point, impact flecks scatter outward then fade',
  },
  // Spearow line — Peck / Drill Peck
  spearow: {
    spriteId: 21, canvasSize: 128,
    attackAction:  'spearow at bottom-left of canvas facing right stays fully visible in every frame, thrusts its sharp beak forward in a quick pecking jab toward the top-right corner, sharp jab streak toward upper-right, side view, pixel art, transparent background',
    attackedAction:'spearow at top-right of canvas facing the viewer stays fully visible in every frame, thrusts its sharp beak forward in a quick pecking jab toward the bottom-left corner, sharp jab streak toward lower-left, front view, pixel art, transparent background',
    hitColor: 0xE8D8B0FF, hitShape: 'star', elemental: false,
    hitDescription: 'peck jab impact, a sharp beak stab bursts at a single point with sharp radiating impact lines, small feather flecks scatter, tan and white, pixel art',
    hitAction: 'a sharp point burst flashes with radiating lines on the jab, feather flecks scatter then fade quickly',
  },
  fearow: {
    spriteId: 22, canvasSize: 256,
    attackAction:  'fearow at bottom-left of canvas facing right stays fully visible in every frame, spins its long beak like a drill thrusting forward toward the top-right corner, spiraling drill motion streak toward upper-right, side view, pixel art, transparent background',
    attackedAction:'fearow at top-right of canvas facing the viewer stays fully visible in every frame, spins its long beak like a drill thrusting forward toward the bottom-left corner, spiraling drill motion streak toward lower-left, front view, pixel art, transparent background',
    hitColor: 0xE0C8A0FF, hitShape: 'star', elemental: false,
    hitDescription: 'drill peck impact, a spinning drilling beak bores into the target with a sharp spiral burst, radiating impact lines and feather flecks spun outward, pixel art',
    hitAction: 'a spinning drill burst bores in with radiating spiral lines, feather flecks fling outward then fade',
  },
  // Ekans line — Poison Sting / Acid
  ekans: {
    spriteId: 23, canvasSize: 128,
    attackAction:  'ekans purple snake at bottom-left of canvas facing right stays fully visible in every frame, spits sharp purple poison stingers from its mouth toward the top-right corner, venom needles streak upper-right, side view, pixel art, transparent background',
    attackedAction:'ekans purple snake at top-right of canvas facing the viewer stays fully visible in every frame, spits sharp purple poison stingers from its mouth toward the bottom-left corner, venom needles streak lower-left, front view, pixel art, transparent background',
    hitColor: 0xA040C0FF, hitShape: 'scatter', elemental: true,
    hitDescription: 'poison sting scatter impact, several sharp purple venom needles jab into the target from different angles, each puncture flashes a purple toxic splash, dark violet droplets scatter, pixel art',
    hitAction: 'venom needles strike from scattered points, each jab flashes a purple splash then droplets scatter and fade',
  },
  arbok: {
    spriteId: 24, canvasSize: 256,
    attackAction:  'arbok large cobra at bottom-left of canvas facing right stays fully visible in every frame, spews a stream of corrosive purple acid from its mouth toward the top-right corner, dripping acid splashes toward upper-right, side view, pixel art, transparent background',
    attackedAction:'arbok large cobra at top-right of canvas facing the viewer stays fully visible in every frame, spews a stream of corrosive purple acid from its mouth toward the bottom-left corner, dripping acid splashes toward lower-left, front view, pixel art, transparent background',
    hitColor: 0x9030B0FF, hitShape: 'vertical', elemental: true,
    hitDescription: 'acid splash impact, a gush of corrosive purple acid splatters onto the target erupting upward, bubbling violet droplets and fumes rise and drip down, sizzling dissolve, pixel art',
    hitAction: 'acid erupts upward on impact, bubbling droplets arc up then drip and sizzle down as fumes rise and fade',
  },
  // Sandshrew line — Sand Attack / Slash
  sandshrew: {
    spriteId: 27, canvasSize: 128,
    attackAction:  'sandshrew at bottom-left of canvas facing right stays fully visible in every frame, kicks up a spray of sand and dust toward the top-right corner, sandy tan cloud streaks upper-right, side view, pixel art, transparent background',
    attackedAction:'sandshrew at top-right of canvas facing the viewer stays fully visible in every frame, kicks up a spray of sand and dust toward the bottom-left corner, sandy tan cloud streaks lower-left, front view, pixel art, transparent background',
    hitColor: 0xD8C078FF, hitShape: 'scatter', elemental: false,
    hitDescription: 'sand attack impact, a scattered spray of tan sand grains and dust puffs blasts into the target from multiple points, gritty sandy cloud with flecks flying, pixel art',
    hitAction: 'sand grains and dust puffs blast from scattered points, grains fly outward then settle and fade',
  },
  sandslash: {
    spriteId: 28, canvasSize: 256,
    attackAction:  'sandslash at bottom-left of canvas facing right stays fully visible in every frame, swipes its long sharp claws forward in a slashing strike toward the top-right corner, sharp claw slash streaks toward upper-right, side view, pixel art, transparent background',
    attackedAction:'sandslash at top-right of canvas facing the viewer stays fully visible in every frame, swipes its long sharp claws forward in a slashing strike toward the bottom-left corner, sharp claw slash streaks toward lower-left, front view, pixel art, transparent background',
    hitColor: 0xE0C888FF, hitShape: 'horizontal', elemental: false,
    hitDescription: 'slash claw impact, three sharp parallel claw slash marks cut across the target with a bright flash, tan and white cutting lines and sparks, pixel art',
    hitAction: 'three parallel claw slashes cut across sharply with a flash, sparks scatter along the cut lines then fade',
  },
  // Vulpix line — Ember / Fire Spin
  vulpix: {
    spriteId: 37, canvasSize: 128,
    attackAction:  'vulpix at bottom-left of canvas facing right stays fully visible in every frame, spits small glowing orange ember sparks from its mouth arcing toward the top-right corner, embers trail upper-right, side view, pixel art, transparent background',
    attackedAction:'vulpix at top-right of canvas facing the viewer stays fully visible in every frame, spits small glowing orange ember sparks from its mouth arcing toward the bottom-left corner, embers trail lower-left, front view, pixel art, transparent background',
    hitColor: 0xFF6B1AFF, hitShape: 'scatter', elemental: true,
    hitDescription: 'ember scatter impact, several small orange-red cinders hit separate spots, each spark bounces and rolls independently, small flame puffs briefly ignite then cool to grey ash, pixel art',
    hitAction: 'individual cinders bounce from separate points, each rolls in a different direction, dims to grey then disappears',
  },
  ninetales: {
    spriteId: 38, canvasSize: 256,
    attackAction:  'ninetales at bottom-left of canvas facing right stays fully visible in every frame, conjures a swirling spiral vortex of orange fire spinning toward the top-right corner, spiraling flame vortex fills upper-right, side view, pixel art, transparent background',
    attackedAction:'ninetales at top-right of canvas facing the viewer stays fully visible in every frame, conjures a swirling spiral vortex of orange fire spinning toward the bottom-left corner, spiraling flame vortex fills lower-left, front view, pixel art, transparent background',
    hitColor: 0xFF7A2AFF, hitShape: 'ring', elemental: true,
    hitDescription: 'fire spin vortex impact, a swirling spiral of orange-red flame rings spins outward trapping the target, concentric fire bands rotate and expand, embers swept around the spiral, pixel art',
    hitAction: 'fire rings spin and expand outward in a spiral vortex, embers swept around then flung outward and burn out',
  },
  // Zubat line — Supersonic / Air Cutter / Cross Poison
  zubat: {
    spriteId: 41, canvasSize: 128,
    attackAction:  'zubat at bottom-left of canvas facing right stays fully visible in every frame, emits rippling supersonic sound waves from its mouth toward the top-right corner, concentric sound ripples travel upper-right, side view, pixel art, transparent background',
    attackedAction:'zubat at top-right of canvas facing the viewer stays fully visible in every frame, emits rippling supersonic sound waves from its mouth toward the bottom-left corner, concentric sound ripples travel lower-left, front view, pixel art, transparent background',
    hitColor: 0x9060C0FF, hitShape: 'ring', elemental: false,
    hitDescription: 'supersonic sound wave impact, concentric rippling sound rings pulse outward through the target, translucent purple and blue sonic waves distort and expand, pixel art',
    hitAction: 'sonic rings pulse outward in sequence from the center, each ring expands and fades from the outer edge inward',
  },
  golbat: {
    spriteId: 42, canvasSize: 128,
    attackAction:  'golbat at bottom-left of canvas facing right with wings spread stays fully visible in every frame, slashes sharp crescent air blades from its wings toward the top-right corner, sharp wind blades streak upper-right, side view, pixel art, transparent background',
    attackedAction:'golbat at top-right of canvas facing the viewer with wings spread stays fully visible in every frame, slashes sharp crescent air blades from its wings toward the bottom-left corner, sharp wind blades streak lower-left, front view, pixel art, transparent background',
    hitColor: 0x88C0D0FF, hitShape: 'horizontal', elemental: false,
    hitDescription: 'air cutter impact, several sharp crescent wind blades slice horizontally across the target, pale cyan cutting arcs with sharp edges, wind slash lines, pixel art',
    hitAction: 'sharp crescent wind blades slice across horizontally one after another, cutting arcs flash then fade',
  },
  crobat: {
    spriteId: 169, canvasSize: 256,
    attackAction:  'crobat with four wings at bottom-left of canvas facing right stays fully visible in every frame, slashes a glowing purple X-shaped cross poison strike toward the top-right corner, two crossing venom blades streak upper-right, side view, pixel art, transparent background',
    attackedAction:'crobat with four wings at top-right of canvas facing the viewer stays fully visible in every frame, slashes a glowing purple X-shaped cross poison strike toward the bottom-left corner, two crossing venom blades streak lower-left, front view, pixel art, transparent background',
    hitColor: 0xB040D0FF, hitShape: 'cross', elemental: true,
    hitDescription: 'cross poison impact, two glowing purple venom blades slash in a crossing shape meeting at the center, toxic violet cross-shaped burst with dripping venom and sparks along both blades, pixel art',
    hitAction: 'two purple venom blades slash crossing at the center, the cross flashes then venom sparks scatter outward and fade',
  },

  // ── 2026-08-23 추가 — 크로뱃 다음 차례 ────────────────────────────────────
  // Pikachu line — Thunder Shock / Thunderbolt
  pikachu: {
    spriteId: 25, canvasSize: 128,
    attackAction:  'pikachu stands at bottom-left corner of canvas facing right, crackling yellow electricity bursts from its red cheeks and arcs diagonally toward the top-right corner, jagged lightning bolts streak upper-right, side view',
    attackedAction:'pikachu stands at top-right corner of canvas facing the viewer, crackling yellow electricity bursts from its red cheeks and arcs diagonally toward the bottom-left corner, jagged lightning bolts streak lower-left, front view',
    hitColor: 0xFFE24AFF, hitShape: 'star', elemental: true,
    hitDescription: 'thunder shock impact, jagged yellow lightning arcs crack outward from the point of impact, small electric sparks snap in the air, pixel art',
    hitAction: 'lightning arcs snap outward in sharp branches, then flicker and vanish from the tips inward',
  },
  raichu: {
    spriteId: 26, canvasSize: 128,
    attackAction:  'raichu stands at bottom-left corner of canvas facing right, a thick bolt of yellow lightning discharges from its cheeks and long tail toward the top-right corner, the bolt forks as it streaks upper-right, side view',
    attackedAction:'raichu stands at top-right corner of canvas facing the viewer, a thick bolt of yellow lightning discharges from its cheeks and long tail toward the bottom-left corner, the bolt forks as it streaks lower-left, front view',
    hitColor: 0xFFD028FF, hitShape: 'star', elemental: true,
    hitDescription: 'thunderbolt impact, a blinding yellow-white electric burst with thick forked branches tearing outward, pixel art',
    hitAction: 'the bolt lands and forks outward, the branches flash white then fade from the outer tips inward',
  },

  // Clefairy line — Pound / Moonblast
  clefairy: {
    spriteId: 35, canvasSize: 128,
    attackAction:  'clefairy stands at bottom-left corner of canvas swinging its short arm upward to the right, a soft pink impact arc trails from its fist toward the top-right corner, side view',
    attackedAction:'clefairy stands at top-right corner of canvas facing the viewer swinging its short arm down to the left, a soft pink impact arc trails from its fist toward the bottom-left corner, front view',
    hitColor: 0xF5A9C8FF, hitShape: 'circle', elemental: false,
    hitDescription: 'pound impact, a blunt pink shockwave puff at the point of contact with a few star-shaped sparkles, pixel art',
    hitAction: 'the puff expands once and fades, sparkles drift outward and wink out',
  },
  clefable: {
    spriteId: 36, canvasSize: 128,
    attackAction:  'clefable stands at bottom-left corner of canvas facing right, gathers a glowing pale-pink moon orb between its raised hands and fires it toward the top-right corner, the orb trails moonlight upper-right, side view',
    attackedAction:'clefable stands at top-right corner of canvas facing the viewer, gathers a glowing pale-pink moon orb between its raised hands and fires it toward the bottom-left corner, the orb trails moonlight lower-left, front view',
    hitColor: 0xF2B8E6FF, hitShape: 'ring', elemental: true,
    hitDescription: 'moonblast impact, a pale pink lunar sphere detonates into concentric rings of moonlight with drifting sparkles, pixel art',
    hitAction: 'rings of moonlight pulse outward one after another, sparkles drift and fade from the outside in',
  },

  // Jigglypuff line — Pound / Hyper Voice
  jigglypuff: {
    spriteId: 39, canvasSize: 128,
    attackAction:  'jigglypuff stands at bottom-left corner of canvas swinging its stubby arm upward to the right, a round pink impact puff trails from its fist toward the top-right corner, side view',
    attackedAction:'jigglypuff stands at top-right corner of canvas facing the viewer swinging its stubby arm down to the left, a round pink impact puff trails from its fist toward the bottom-left corner, front view',
    hitColor: 0xF7B5D0FF, hitShape: 'circle', elemental: false,
    hitDescription: 'pound impact, a soft round pink shockwave at the point of contact, pixel art',
    hitAction: 'the shockwave swells once then shrinks back to nothing',
  },
  wigglytuff: {
    spriteId: 40, canvasSize: 128,
    attackAction:  'wigglytuff stands at bottom-left corner of canvas facing right with its mouth wide open, rippling pink sound rings blast from its mouth toward the top-right corner, concentric rings travel upper-right, side view',
    attackedAction:'wigglytuff stands at top-right corner of canvas facing the viewer with its mouth wide open, rippling pink sound rings blast from its mouth toward the bottom-left corner, concentric rings travel lower-left, front view',
    hitColor: 0xF48FC0FF, hitShape: 'ring', elemental: false,
    hitDescription: 'hyper voice impact, loud concentric pink sound rings hammer through the target, the air distorts along each ring, pixel art',
    hitAction: 'sound rings pulse outward in quick succession, each ring thins and fades from its outer edge',
  },

  // Oddish line — Absorb / Acid / Solar Beam
  oddish: {
    spriteId: 43, canvasSize: 128,
    attackAction:  'oddish stands at bottom-left corner of canvas facing right, thin green draining tendrils reach from its leaves toward the top-right corner, small green energy motes travel back along them, side view',
    attackedAction:'oddish stands at top-right corner of canvas facing the viewer, thin green draining tendrils reach from its leaves toward the bottom-left corner, small green energy motes travel back along them, front view',
    hitColor: 0x7FC24AFF, hitShape: 'circle', elemental: false,
    hitDescription: 'absorb impact, soft green energy motes are pulled out of the target and spiral away, faint green glow at the contact point, pixel art',
    hitAction: 'motes lift off the target and spiral away, dimming as they go',
  },
  gloom: {
    spriteId: 44, canvasSize: 128,
    attackAction:  'gloom stands at bottom-left corner of canvas facing right, spits a splash of sizzling purple acid from its mouth arcing toward the top-right corner, acid droplets trail upper-right, side view',
    attackedAction:'gloom stands at top-right corner of canvas facing the viewer, spits a splash of sizzling purple acid from its mouth arcing toward the bottom-left corner, acid droplets trail lower-left, front view',
    hitColor: 0xA24AC8FF, hitShape: 'scatter', elemental: true,
    hitDescription: 'acid splash impact, purple corrosive droplets burst and sizzle where they land, small dissolving bubbles pop, pixel art',
    hitAction: 'droplets splatter outward in separate arcs, sizzle, then dissolve one by one',
  },
  vileplume: {
    spriteId: 45, canvasSize: 128,
    attackAction:  'vileplume stands at bottom-left corner of canvas facing right, a bright yellow-green beam of stored sunlight fires from the giant flower on its head toward the top-right corner, the beam fills the upper-right, side view',
    attackedAction:'vileplume stands at top-right corner of canvas facing the viewer, a bright yellow-green beam of stored sunlight fires from the giant flower on its head toward the bottom-left corner, the beam fills the lower-left, front view',
    hitColor: 0xE4FF52FF, hitShape: 'star', elemental: true,
    hitDescription: 'solar beam impact, a blinding yellow-green light detonation with straight rays shooting outward like a compass rose, pixel art',
    hitAction: 'rays shoot out to full length together, then fade from the tips inward leaving a dimming afterglow',
  },
};

// ---------------------------------------------------------------------------
// Versioning — never overwrite; save as v2, v3, v4...
// ---------------------------------------------------------------------------

function versionedPath(outPath) {
  if (!existsSync(outPath)) return outPath;
  const dir = dirname(outPath);
  const base = basename(outPath, '.gif');
  for (let v = 2; v <= 99; v++) {
    const p = join(dir, `${base}-v${v}.gif`);
    if (!existsSync(p)) return p;
  }
  return outPath;
}

// ---------------------------------------------------------------------------
// Image helpers
// ---------------------------------------------------------------------------

// corner: 'bottom-left' | 'top-right'
async function padSprite(spriteId, canvasSize, corner = 'bottom-left') {
  const front = corner === 'top-right';
  const dir = front ? SPRITES_FRONT : SPRITES_BACK;
  // Sprites are named `${dexId}-${slug}.gif` (e.g. 6-charizard.gif); fall back to legacy `${id}.gif`.
  const fname = readdirSync(dir).find(f => f.startsWith(`${spriteId}-`) && f.endsWith('.gif')) ?? `${spriteId}.gif`;
  const spritePath = join(dir, fname);
  const img = await Jimp.read(spritePath);

  // Scale down if taller than canvas
  if (img.height > canvasSize) {
    const ratio = canvasSize / img.height;
    img.resize({ w: Math.floor(img.width * ratio), h: canvasSize, mode: ResizeStrategy.NEAREST_NEIGHBOR });
  }

  const canvas = new Jimp({ width: canvasSize, height: canvasSize, color: 0x00000000 });
  const x = corner === 'bottom-left' ? 0 : canvasSize - img.width;
  const y = corner === 'bottom-left' ? canvasSize - img.height : 0;
  canvas.composite(img, x, y);

  const buf = await canvas.getBuffer(JimpMime.png);
  return { base64: buf.toString('base64'), w: canvasSize, h: canvasSize };
}

// Create a shaped reference image for hit-fx color hinting.
// shape: 'circle' | 'horizontal' | 'vertical' | 'ring' | 'star' | 'scatter'
async function burstRef64(color = 0xFFFFFFFF, shape = 'circle') {
  const img = new Jimp({ width: 64, height: 64, color: 0x00000000 });
  const cx = 32, cy = 32;
  const base = color >>> 8;
  const paint = (x, y, alpha) => {
    if (alpha <= 0) return;
    img.setPixelColor(((base << 8) | Math.min(255, alpha)) >>> 0, x, y);
  };

  if (shape === 'circle') {
    const r = 20;
    for (let x = 0; x < 64; x++)
      for (let y = 0; y < 64; y++) {
        const d = Math.sqrt((x-cx)**2 + (y-cy)**2);
        if (d < r) paint(x, y, Math.floor(255 * (1 - d / r)));
      }

  } else if (shape === 'horizontal') {
    // Wide flat ellipse (rx=28, ry=10)
    for (let x = 0; x < 64; x++)
      for (let y = 0; y < 64; y++) {
        const d = Math.sqrt(((x-cx)/28)**2 + ((y-cy)/10)**2);
        if (d < 1) paint(x, y, Math.floor(255 * (1 - d)));
      }

  } else if (shape === 'vertical') {
    // Tall ellipse (rx=10, ry=28)
    for (let x = 0; x < 64; x++)
      for (let y = 0; y < 64; y++) {
        const d = Math.sqrt(((x-cx)/10)**2 + ((y-cy)/28)**2);
        if (d < 1) paint(x, y, Math.floor(255 * (1 - d)));
      }

  } else if (shape === 'ring') {
    // Donut between r=12 and r=26
    for (let x = 0; x < 64; x++)
      for (let y = 0; y < 64; y++) {
        const d = Math.sqrt((x-cx)**2 + (y-cy)**2);
        if (d >= 12 && d < 26) {
          const t = (d - 12) / 14; // 0→1 across ring width
          paint(x, y, Math.floor(255 * (1 - Math.abs(t - 0.5) * 2)));
        }
      }

  } else if (shape === 'star') {
    // 8-armed star up to r=28
    for (let x = 0; x < 64; x++)
      for (let y = 0; y < 64; y++) {
        const dx = x - cx, dy = y - cy;
        const d = Math.sqrt(dx*dx + dy*dy);
        if (d === 0 || d > 28) continue;
        const angle = Math.atan2(dy, dx);
        // Nearest arm angle (every 45°)
        const nearest = Math.round(angle / (Math.PI / 4)) * (Math.PI / 4);
        let diff = Math.abs(angle - nearest);
        if (diff > Math.PI) diff = 2 * Math.PI - diff;
        const armWidth = Math.PI / 10;
        if (diff < armWidth)
          paint(x, y, Math.floor(255 * (1 - d/28) * (1 - diff/armWidth)));
      }

  } else if (shape === 'scatter') {
    // 9 small dots scattered across the frame
    const dots = [
      {x:32,y:32,r:6}, {x:18,y:20,r:4}, {x:46,y:18,r:4},
      {x:14,y:44,r:3}, {x:50,y:46,r:3}, {x:32,y:12,r:3},
      {x:32,y:52,r:3}, {x:10,y:32,r:3}, {x:54,y:32,r:3},
    ];
    for (let x = 0; x < 64; x++)
      for (let y = 0; y < 64; y++) {
        let best = 0;
        for (const d of dots) {
          const dist = Math.sqrt((x-d.x)**2 + (y-d.y)**2);
          if (dist < d.r) best = Math.max(best, Math.floor(255 * (1 - dist/d.r)));
        }
        if (best > 0) paint(x, y, best);
      }

  } else if (shape === 'cross') {
    // Plus-shaped cross: vertical + horizontal flame bars (Fire Blast 大)
    const arm = 28, halfW = 6;
    for (let x = 0; x < 64; x++)
      for (let y = 0; y < 64; y++) {
        const dx = x - cx, dy = y - cy;
        const inV = Math.abs(dx) <= halfW && Math.abs(dy) <= arm;
        const inH = Math.abs(dy) <= halfW && Math.abs(dx) <= arm;
        if (inV || inH) {
          const dist = Math.sqrt(dx*dx + dy*dy);
          paint(x, y, Math.floor(255 * (1 - Math.min(1, dist / arm))));
        }
      }
  }

  const buf = await img.getBuffer(JimpMime.png);
  return buf.toString('base64');
}

// Flood-fill from canvas edges to mark true background, then iteratively fill interior
// transparent holes by propagating color inward from opaque boundaries — one layer per
// pass, repeated until no holes remain (handles holes of any size).
function fillInteriorHoles(data, w, h) {
  const n = w * h;
  const isTransp = (i) => data[i * 4 + 3] < 128;

  // BFS from all edge-touching transparent pixels → mark as real background
  const isBg = new Uint8Array(n);
  const queue = [];
  const seed = (i) => { if (!isBg[i] && isTransp(i)) { isBg[i] = 1; queue.push(i); } };
  for (let x = 0; x < w; x++)     { seed(x); seed((h - 1) * w + x); }
  for (let y = 1; y < h - 1; y++) { seed(y * w); seed(y * w + w - 1); }
  let head = 0;
  while (head < queue.length) {
    const i = queue[head++];
    const x = i % w, y = (i / w) | 0;
    if (x > 0)     seed(i - 1);
    if (x < w - 1) seed(i + 1);
    if (y > 0)     seed(i - w);
    if (y < h - 1) seed(i + w);
  }

  // Iterative fill: each pass spreads opaque color one pixel into the hole.
  // Repeats until no interior transparent pixels remain.
  let filled = 0;
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < n; i++) {
      if (isBg[i] || !isTransp(i)) continue;
      const x = i % w, y = (i / w) | 0;
      let r = 0, g = 0, b = 0, cnt = 0;
      const sample = (ni) => { if (!isTransp(ni)) { r += data[ni*4]; g += data[ni*4+1]; b += data[ni*4+2]; cnt++; } };
      if (x > 0)     sample(i - 1);
      if (x < w - 1) sample(i + 1);
      if (y > 0)     sample(i - w);
      if (y < h - 1) sample(i + w);
      if (cnt > 0) {
        data[i*4] = Math.round(r/cnt); data[i*4+1] = Math.round(g/cnt);
        data[i*4+2] = Math.round(b/cnt); data[i*4+3] = 255;
        changed = true; filled++;
      }
    }
  }
  if (filled > 0) process.stdout.write(` [filled ${filled}px]`);
}

// BFS from all 4 corners using their colors as background seeds. Spreads freely
// through transparent pixels; removes opaque pixels only when their color is
// within threshold of a corner seed — preserves character outlines intact.
function removeEdgeBackground(data, w, h) {
  const n = w * h;
  const isTransp = (i) => data[i * 4 + 3] < 128;
  const visited = new Uint8Array(n);
  const queue = [];

  // Collect opaque corner seeds and start BFS from all 4 corners
  const corners = [0, w - 1, (h - 1) * w, (h - 1) * w + w - 1];
  const seeds = [];
  for (const ci of corners) {
    if (!isTransp(ci)) seeds.push({ r: data[ci*4], g: data[ci*4+1], b: data[ci*4+2] });
    if (!visited[ci]) { visited[ci] = 1; queue.push(ci); }
  }
  if (seeds.length === 0) return; // all corners already transparent — nothing to do

  const isBgColor = (i) => {
    const r = data[i*4], g = data[i*4+1], b = data[i*4+2];
    for (const s of seeds) {
      const dr = r - s.r, dg = g - s.g, db = b - s.b;
      if (dr*dr + dg*dg + db*db < 400) return true; // ~20 per channel
    }
    return false;
  };

  let head = 0;
  while (head < queue.length) {
    const i = queue[head++];
    const x = i % w, y = (i / w) | 0;
    const tryAdd = (ni) => {
      if (visited[ni]) return;
      if (isTransp(ni)) {
        visited[ni] = 1; queue.push(ni);        // spread through transparent freely
      } else if (isBgColor(ni)) {
        visited[ni] = 1; data[ni*4+3] = 0; queue.push(ni); // remove bg artifact
      }
    };
    if (x > 0)     tryAdd(i - 1);
    if (x < w - 1) tryAdd(i + 1);
    if (y > 0)     tryAdd(i - w);
    if (y < h - 1) tryAdd(i + w);
  }
}

async function framesToGif(framesB64, outPath, fps = 4, removeBackground = false, fillHoles = false) {
  const delay = Math.floor(1000 / fps);

  let width, height;
  const bitmaps = [];
  for (const f of framesB64) {
    const raw = typeof f === 'string' ? f : (f.base64 ?? f.image?.base64 ?? '');
    const b64 = raw.startsWith('data:') ? raw.split(',')[1] : raw;
    const img = await Jimp.read(Buffer.from(b64, 'base64'));
    if (fillHoles) {
      removeEdgeBackground(img.bitmap.data, img.bitmap.width, img.bitmap.height);
      fillInteriorHoles(img.bitmap.data, img.bitmap.width, img.bitmap.height);
    }
    if (removeBackground) {
      const d = img.bitmap.data;
      const bgR = d[0], bgG = d[1], bgB = d[2];
      for (let i = 0; i < d.length; i += 4) {
        const dr = d[i] - bgR, dg = d[i+1] - bgG, db = d[i+2] - bgB;
        if (dr*dr + dg*dg + db*db < 900) d[i+3] = 0;
      }
    }
    // Pre-seed transparent pixels with magenta RGB so gif-encoder-2's findClosest(0xFF00FF)
    // gets an exact distance-0 match and never collides with character palette entries.
    const d = img.bitmap.data;
    let opaqueCount = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i+3] < 128) { d[i] = 255; d[i+1] = 0; d[i+2] = 255; }
      else opaqueCount++;
    }
    if (opaqueCount === 0) { process.stdout.write(' [blank frame]'); continue; }
    if (!width) { width = img.bitmap.width; height = img.bitmap.height; }
    bitmaps.push(Buffer.from(img.bitmap.data));
  }

  if (bitmaps.length === 0) { console.log(' ✗ all frames blank, skipping'); return; }

  mkdirSync(dirname(outPath), { recursive: true });
  const savePath = versionedPath(outPath);

  const encoder = new GifEncoder(width, height, 'neuquant', true);
  encoder.setDelay(delay);
  encoder.setRepeat(0);
  encoder.setTransparent(0xFF00FF);

  const readStream = encoder.createReadStream();
  const file = createWriteStream(savePath);
  readStream.pipe(file);

  await new Promise((resolve, reject) => {
    file.on('finish', resolve);
    file.on('error', reject);

    encoder.start();
    for (const bitmap of bitmaps) encoder.addFrame(bitmap);
    encoder.finish();
  });

  console.log(`  ✓ ${savePath.replace(ASSETS_ROOT, '').replace(/\\/g, '/')}`);
}

// Sample the dominant elemental color from an existing attack-fx GIF.
// Reads the first frame, discards transparent + near-black pixels, then returns
// the most frequent (r,g,b) rounded to nearest 16 — packed as 0xRRGGBBFF.
async function sampleAttackFxColor(name, fallback) {
  const gifPath = join(OUTPUT_DIR, name, 'attack-fx.gif');
  if (!existsSync(gifPath)) return fallback;
  try {
    const img = await Jimp.read(gifPath);
    const d = img.bitmap.data;
    const freq = new Map();
    for (let i = 0; i < d.length; i += 4) {
      if (d[i+3] < 128) continue;                   // transparent
      if (d[i] + d[i+1] + d[i+2] < 60) continue;   // near-black
      // Quantize to 16-step buckets to group similar colors
      const key = `${d[i]>>4},${d[i+1]>>4},${d[i+2]>>4}`;
      freq.set(key, (freq.get(key) ?? 0) + 1);
    }
    if (freq.size === 0) return fallback;
    const [best] = [...freq.entries()].sort((a, b) => b[1] - a[1]);
    const [r, g, b] = best[0].split(',').map(v => (parseInt(v) << 4) | 8);
    const packed = (((r << 24) | (g << 16) | (b << 8) | 0xFF) >>> 0);
    process.stdout.write(` [hitColor sampled rgb(${r},${g},${b})]`);
    return packed;
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

async function apiPost(endpoint, payload) {
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(`${BASE_URL}${endpoint}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`${endpoint} ${res.status}: ${txt}`);
      }
      return res.json();
    } catch (e) {
      if (e.message?.includes(`${endpoint} `)) throw e; // HTTP status error — don't retry
      lastErr = e;
      process.stdout.write(' [net retry] ');
      await new Promise(r => setTimeout(r, 3000));
    }
  }
  throw lastErr;
}

async function pollJob(jobId, timeout = 360_000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    let data;
    try {
      const res = await fetch(`${BASE_URL}/background-jobs/${jobId}`, {
        headers: { Authorization: `Bearer ${API_KEY}` },
      });
      data = await res.json();
    } catch {
      process.stdout.write('x'); // transient network error — keep polling, job still runs server-side
      await new Promise(r => setTimeout(r, 4000));
      continue;
    }
    if (data.status === 'completed') return data.last_response ?? data;
    if (data.status === 'failed') throw new Error(`Job ${jobId} failed: ${JSON.stringify(data)}`);
    process.stdout.write('.');
    await new Promise(r => setTimeout(r, 4000));
  }
  throw new Error(`Job ${jobId} timed out`);
}

// The style tail is the whole point of the prompt -- without it v2 renders smooth
// artwork on an opaque background. It used to sit at the very end of each config's
// action text, which is exactly what the 500-char guard chopped off: 33 of 62 prompts
// shipped without `pixel art` and all 33 without `transparent background`. Now it is
// held back and re-attached AFTER trimming, so it can never be the part that is lost.
const STYLE_TAIL = ' pixel art, transparent background.';

/** Trims from the middle, never the end, and says so out loud. */
function fitAction(action, budget) {
  if (action.length <= budget) return action;
  const keepTail = 90;                       // the move description usually lands here
  const head = budget - keepTail - 2;
  const out = action.slice(0, head).trimEnd() + ' … ' + action.slice(-keepTail).trimStart();
  console.log(`  ⚠ 프롬프트가 길어 가운데를 ${action.length - out.length}자 줄였습니다 (${action.length}→${out.length})`);
  return out;
}

async function animateV2(refBase64, refW, refH, action, direction, view = 'side') {
  const SUFFIX = ' — keep the reference sprite\'s exact colors and low-resolution pixel style.';
  const base = fitAction(action, 500 - SUFFIX.length - STYLE_TAIL.length);
  const colorLockedAction = base + STYLE_TAIL + SUFFIX;
  // ImageInput requires data URI prefix; no extra fields like "format"
  const b64Uri = refBase64.startsWith('data:') ? refBase64 : `data:image/png;base64,${refBase64}`;
  let data = await apiPost('/animate-with-text-v2', {
    reference_image: { base64: b64Uri },
    reference_image_size: { width: refW, height: refH },
    image_size: { width: refW, height: refH },
    action: colorLockedAction,
    direction,
    view,
    no_background: true,
  });

  const jobId = data.background_job_id ?? data.job_id;
  if (jobId) {
    process.stdout.write('  polling');
    data = await pollJob(jobId);
    console.log(' done');
  }
  return data.frames ?? data.images ?? [];
}

async function animateFree(description, action, hitColor, hitShape = 'circle') {
  const refB64 = await burstRef64(hitColor, hitShape);
  const data = await apiPost('/animate-with-text', {
    image_size: { width: 64, height: 64 },
    description,
    action,
    reference_image: { base64: refB64, format: 'png' },
    n_frames: 8,
    view: 'side',
  });
  return data.frames ?? data.images ?? [];
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

// v2 tends to clone the sprite across an empty canvas — pin every attack/attacked to one character.
// Anchors are charged against the same 500 characters as the move description, so they
// are kept as short as they can be and still work. The long-winded versions ate 240 of
// the 500 and left only ~150 for the move itself -- charizard's Fire Blast description
// was cut off mid-word and the API never learned what to draw.
const SINGLE = 'exactly one character, never duplicated.';
const BEHIND = ' seen strictly from behind, its face never visible, it never turns around.';

async function stepAttack(name, cfg, count = 1) {
  console.log(`  [1/3] attack-fx.gif (NE) ×${count}...`);
  const { base64, w, h } = await padSprite(cfg.spriteId, cfg.canvasSize, 'bottom-left');
  // Back-sprite attack: the reference already faces away (NE). Force the model to keep that
  // rear view — it otherwise loves to spin the character around to show its face. Also pin it to
  // a single character (v2 likes to clone the sprite across an empty canvas). Prepended so the
  // 500-char guard never trims these anchors.
  const action = `${SINGLE}${BEHIND} ${cfg.attackAction}`;
  const results = await Promise.all(
    Array.from({ length: count }, () => animateV2(base64, w, h, action, 'north-east', 'side'))
  );
  for (const frames of results) {
    // Force the animation to START from the exact reference sprite (never a redrawn character):
    // prepend the padded reference as frame 0.
    await framesToGif([base64, ...frames], join(OUTPUT_DIR, name, 'attack-fx.gif'), 4, false, true);
  }
}

async function stepAttacked(name, cfg, count = 1) {
  console.log(`  [2/3] attacked-fx.gif (SW, front sprite) ×${count}...`);
  const { base64, w, h } = await padSprite(cfg.spriteId, cfg.canvasSize, 'top-right');
  const action = `${SINGLE} ${cfg.attackedAction}`;
  const results = await Promise.all(
    Array.from({ length: count }, () => animateV2(base64, w, h, action, 'south-west', 'side'))
  );
  for (const frames of results) {
    // Start from the exact reference sprite: prepend the padded reference as frame 0.
    await framesToGif([base64, ...frames], join(OUTPUT_DIR, name, 'attacked-fx.gif'), 4, false, true);
  }
}

async function stepHit(name, cfg, count = 1) {
  console.log(`  [3/3] hit-fx.gif ×${count}...`);
  const hitColor = cfg.elemental
    ? await sampleAttackFxColor(name, cfg.hitColor)
    : cfg.hitColor;
  const results = await Promise.all(
    Array.from({ length: count }, () => animateFree(cfg.hitDescription, cfg.hitAction, hitColor, cfg.hitShape ?? 'circle'))
  );
  for (const frames of results) {
    await framesToGif(frames, join(OUTPUT_DIR, name, 'hit-fx.gif'), 4, true);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function run(name, step, count = 1) {
  const cfg = CHARACTERS[name];
  console.log(`\n${'─'.repeat(48)}\n  ${name}\n${'─'.repeat(48)}`);
  if (!step || step === 'attack')   await stepAttack(name, cfg, count);
  if (!step || step === 'attacked') await stepAttacked(name, cfg, count);
  if (!step || step === 'hit')      await stepHit(name, cfg, 1); // hit uses monthly quota — always 1
  console.log(`  done.\n`);
}

const args = process.argv.slice(2);

if (args.includes('--list')) {
  console.log('Available characters:');
  for (const [name, cfg] of Object.entries(CHARACTERS))
    console.log(`  ${name.padEnd(12)} sprite #${cfg.spriteId}, canvas ${cfg.canvasSize}px`);
  process.exit(0);
}

if (!API_KEY) { console.error('Error: PIXELLAB_API_KEY not set'); process.exit(1); }

const stepArg  = args.includes('--step')  ? args[args.indexOf('--step')  + 1] : null;
const countArg = args.includes('--count') ? parseInt(args[args.indexOf('--count') + 1], 10) : 1;

if (args.includes('--all')) {
  for (const name of Object.keys(CHARACTERS)) await run(name, stepArg, countArg);
} else {
  const name = args.find(a => !a.startsWith('--') && a !== stepArg && isNaN(Number(a)));
  if (!name || !CHARACTERS[name]) {
    console.log('Usage: node generate_skill_fx.mjs <character|--all> [--step attack|attacked|hit] [--count N]');
    console.log('       node generate_skill_fx.mjs --list');
    process.exit(1);
  }
  await run(name, stepArg, countArg);
}
