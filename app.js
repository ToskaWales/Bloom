// ═══════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════
const MS_PER_DAY = 86400000;
const DEFAULT_PHASE_LENGTHS = Object.freeze({ menstrual: 5, follicular: 8, ovulatory: 3, luteal: 12 });

/** Round a load value to the nearest 1.25 kg plate increment. */
function roundToPlate(load) { return Math.round(load / 1.25) * 1.25; }

// ═══════════════════════════════════════════
// APP STATE
// ═══════════════════════════════════════════
const state = {
  name: 'Sofia',
  goals: ['strength'],
  level: 1,
  mood: 3,
  energy: 6,
  symptoms: [],
  workoutsCompleted: 0,
  streak: 0,
  listenedToBody: 0,
  totalMins: 0,
  moodHistory: [],
  checkinDone: false,
  phase: null,

  // ── WEEK PLANNER ──
  weekSchedule: null,
  weekScheduleWeek: null,
  weekCompletions: {},

  // ── GAMIFICATION ──
  badges: [],      // string[] of earned badge keys
  prHistory: [],   // { date, exercise, load, phase }[] for PR Queen badge

  // ── VIRTUAL PET ──
  pet: null,       // { type, health, lastFedDate, totalFeeds } or null

  // ── PERSONAL CYCLE MODEL ──
  // Seeded from onboarding, refined by "period started" events + symptom inference
  cycle: {
    // Last period start — ISO date string or null
    lastPeriodStart: null,
    // Learned personal phase lengths (days). Defaults = population averages.
    // Updated every time a new period is confirmed.
    phaseLengths: { ...DEFAULT_PHASE_LENGTHS },
    // Total learned cycle length (sum of above)
    cycleLength: 28,
    // Historical period start dates (ISO strings) — used to learn inter-cycle timing
    periodHistory: [],
    // Confidence level 0–1 in current phase estimate
    // Low = just seeded, high = multiple confirmed periods
    confidence: 0.4,
    // Apple Health sync status
    healthKitLinked: false,
    // Symptom inference model: maps symptom patterns → phase probability weights
    // Updated each cycle from confirmed symptom-phase pairs
    symptomWeights: {
      // symptom: { menstrual, follicular, ovulatory, luteal }
      cramps:     { menstrual:0.9, follicular:0.1, ovulatory:0.1, luteal:0.2 },
      bloated:    { menstrual:0.7, follicular:0.1, ovulatory:0.1, luteal:0.6 },
      tired:      { menstrual:0.7, follicular:0.2, ovulatory:0.1, luteal:0.6 },
      headache:   { menstrual:0.5, follicular:0.1, ovulatory:0.2, luteal:0.5 },
      stressed:   { menstrual:0.3, follicular:0.2, ovulatory:0.1, luteal:0.7 },
      motivated:  { menstrual:0.1, follicular:0.7, ovulatory:0.9, luteal:0.2 },
      great:      { menstrual:0.1, follicular:0.6, ovulatory:0.9, luteal:0.2 },
      sore:       { menstrual:0.2, follicular:0.3, ovulatory:0.5, luteal:0.3 },
    },
  },
};

// ═══════════════════════════════════════════
// PHASE DATA + EXERCISE DB + PROGRESSION ENGINE
// ═══════════════════════════════════════════
const PHASES = {
  menstrual: {
    name: 'Menstrual', icon: '🌹', day: '1–5',
    color: '#F2A7B4', colorD: '#E8849A', bg: '#FDE8EE', textColor: '#4A1F2E',
    desc: 'Estrogen and progesterone are at their lowest. Your body is shedding and renewing.',
    chips: ['Rest is training', 'Iron-rich foods', 'Light gym session'],
    arcIdx: 0,
    insight: '🩸 Your immune system is slightly suppressed. Machines and cables reduce joint stress while keeping you moving. Light load now protects your follicular peak.',
    volumeScale: 0.70, intensityMax: 'light', preferMachines: true,
  },
  follicular: {
    name: 'Follicular', icon: '🌷', day: '6–13',
    color: '#C9B8E8', colorD: '#A896D4', bg: '#EDE8F5', textColor: '#2D1A4A',
    desc: 'Estrogen is rising. Your energy, focus, and mood are building. This is your growth phase.',
    chips: ['Progressive overload', 'Learn new lifts', 'Build your base'],
    arcIdx: 1,
    insight: '💫 Rising estrogen boosts neuromuscular coordination and protein synthesis. Recovery is fastest here. Add load every session while technique stays clean.',
    volumeScale: 1.0, intensityMax: 'heavy', preferMachines: false,
  },
  ovulatory: {
    name: 'Ovulatory', icon: '⚡️', day: '14–16',
    color: '#F9C9A3', colorD: '#F0A873', bg: '#FEF3E8', textColor: '#4A2E10',
    desc: 'Estrogen and LH peak. This is your physical peak — strength, coordination, and power are maximal.',
    chips: ['Hit your PRs', 'Heavy compounds', 'Peak power'],
    arcIdx: 2,
    insight: '⚡️ LH surge + peak estrogen = your highest strength, coordination, and pain tolerance. Best window for 1RMs and heavy triples. Make it count.',
    volumeScale: 1.10, intensityMax: 'max', preferMachines: false,
  },
  luteal: {
    name: 'Luteal', icon: '🍂', day: '17–28',
    color: '#B8D4C0', colorD: '#8CBF9C', bg: '#E8F5EE', textColor: '#1A3D2A',
    desc: 'Progesterone rises then falls. Energy may dip, mood may fluctuate. Maintenance is success.',
    chips: ['Maintain the gains', 'Moderate loads', 'Quality reps'],
    arcIdx: 3,
    insight: '🍃 Progesterone slows recovery and raises core temperature. Cut volume ~20%, keep technique sharp. The gains from follicular consolidate now — protecting them is the goal.',
    volumeScale: 0.80, intensityMax: 'moderate', preferMachines: false,
  }
};

// ── ACHIEVEMENT BADGES ──
const BADGES = {
  first_bloom: {
    icon: '🌸', name: 'First Bloom',
    desc: 'You completed your very first Bloom workout.',
    color: '#F2A7B4', colorD: '#E8849A',
    check: () => state.workoutsCompleted >= 1,
  },
  streak_queen: {
    icon: '🔥', name: 'Streak Queen',
    desc: '7 workouts in a row. You\'re unstoppable.',
    color: '#F9C9A3', colorD: '#F0A873',
    check: () => state.streak >= 7,
  },
  pr_queen: {
    icon: '👑', name: 'PR Queen',
    desc: 'Hit a personal record. Your peak paid off.',
    color: '#C9B8E8', colorD: '#A896D4',
    check: () => (state.prHistory || []).length > 0,
  },
  phase_master: {
    icon: '🌙', name: 'Phase Master',
    desc: 'Trained across all 4 phases of your cycle.',
    color: '#B8D4C0', colorD: '#8CBF9C',
    check: () => new Set((state.moodHistory || []).map(e => e.phase).filter(Boolean)).size >= 4,
  },
  cycle_whisperer: {
    icon: '✨', name: 'Cycle Whisperer',
    desc: 'Your cycle model reached 80% confidence.',
    color: '#F2A7B4', colorD: '#C9B8E8',
    check: () => (state.cycle.confidence || 0) >= 0.8,
  },
  ten_strong: {
    icon: '💪', name: '10 Workouts Strong',
    desc: 'Double digits. You\'re building something real.',
    color: '#F9C9A3', colorD: '#A896D4',
    check: () => state.workoutsCompleted >= 10,
  },
};

// ── VIRTUAL PET ──
const PET_TYPES = {
  cat:    { emoji: '🐱', name: 'Luna',   happy: '😻', hungry: '🙀', sad: '😿' },
  bunny:  { emoji: '🐰', name: 'Clover', happy: '🥰', hungry: '😢', sad: '😢' },
  dog:    { emoji: '🐶', name: 'Poppy',  happy: '🥳', hungry: '🥺', sad: '😰' },
  flower: { emoji: '🌸', name: 'Bloom',  happy: '🌺', hungry: '🌷', sad: '🥀' },
};

// ── EXERCISE LIBRARY ──
const EXERCISE_DB = {
  barbell_squat:     { name:'Barbell Back Squat',     muscle:'quads',    equip:'barbell',   tier:'heavy',   icon:'🏋️', color:'#EDE8F5', baseReps:5,  baseSets:4, detail:'Rack · drive through heels' },
  front_squat:       { name:'Barbell Front Squat',    muscle:'quads',    equip:'barbell',   tier:'heavy',   icon:'🏋️', color:'#EDE8F5', baseReps:5,  baseSets:4, detail:'Elbows up · upright torso' },
  goblet_squat:      { name:'Goblet Squat',           muscle:'quads',    equip:'dumbbell',  tier:'moderate',icon:'🏋️', color:'#EDE8F5', baseReps:10, baseSets:3, detail:'DB · heels on plates if needed' },
  leg_press:         { name:'Leg Press',              muscle:'quads',    equip:'machine',   tier:'light',   icon:'🦵', color:'#FDE8EE', baseReps:12, baseSets:3, detail:'Shoulder-width · full ROM' },
  leg_extension:     { name:'Leg Extension',          muscle:'quads',    equip:'machine',   tier:'light',   icon:'🏃', color:'#EDE8F5', baseReps:15, baseSets:3, detail:'Machine · quad isolation' },
  bulgarian_squat:   { name:'Bulgarian Split Squat',  muscle:'quads',    equip:'dumbbell',  tier:'moderate',icon:'🦵', color:'#EDE8F5', baseReps:8,  baseSets:3, detail:'Rear foot elevated · per leg' },
  hack_squat:        { name:'Hack Squat',             muscle:'quads',    equip:'machine',   tier:'moderate',icon:'🦵', color:'#FDE8EE', baseReps:10, baseSets:4, detail:'Machine · deep ROM' },
  barbell_hip_thrust:{ name:'Barbell Hip Thrust',     muscle:'glutes',   equip:'barbell',   tier:'heavy',   icon:'🍑', color:'#FDE8EE', baseReps:8,  baseSets:4, detail:'Bench · drive through heels' },
  db_hip_thrust:     { name:'DB Hip Thrust',          muscle:'glutes',   equip:'dumbbell',  tier:'moderate',icon:'🍑', color:'#FDE8EE', baseReps:12, baseSets:3, detail:'Single DB · controlled squeeze' },
  cable_kickback:    { name:'Cable Glute Kickback',   muscle:'glutes',   equip:'cable',     tier:'light',   icon:'🍑', color:'#FDE8EE', baseReps:15, baseSets:3, detail:'Cable · slow eccentric' },
  sumo_deadlift:     { name:'Sumo Deadlift',          muscle:'glutes',   equip:'barbell',   tier:'heavy',   icon:'💥', color:'#FEF3E8', baseReps:5,  baseSets:4, detail:'Wide stance · bar close' },
  rdl:               { name:'Romanian Deadlift',      muscle:'glutes',   equip:'barbell',   tier:'moderate',icon:'🔄', color:'#E8F5EE', baseReps:8,  baseSets:4, detail:'Hip hinge · feel the stretch' },
  db_rdl:            { name:'DB Romanian Deadlift',   muscle:'glutes',   equip:'dumbbell',  tier:'moderate',icon:'🔄', color:'#E8F5EE', baseReps:10, baseSets:3, detail:'Dumbbell · hip hinge' },
  walking_lunge:     { name:'DB Walking Lunge',       muscle:'glutes',   equip:'dumbbell',  tier:'moderate',icon:'🚶', color:'#E8F5EE', baseReps:10, baseSets:3, detail:'Per leg · upright torso' },
  leg_curl_seated:   { name:'Seated Leg Curl',        muscle:'hamstring',equip:'machine',   tier:'light',   icon:'🔄', color:'#E8F5EE', baseReps:12, baseSets:3, detail:'Machine · full ROM' },
  leg_curl_lying:    { name:'Lying Leg Curl',         muscle:'hamstring',equip:'machine',   tier:'light',   icon:'🔄', color:'#E8F5EE', baseReps:12, baseSets:3, detail:'Machine · controlled' },
  nordic_curl:       { name:'Nordic Curl',            muscle:'hamstring',equip:'bodyweight',tier:'moderate',icon:'🦵', color:'#EDE8F5', baseReps:6,  baseSets:3, detail:'Eccentric focus · slow lower' },
  barbell_row:       { name:'Barbell Bent-Over Row',  muscle:'back',     equip:'barbell',   tier:'heavy',   icon:'🏹', color:'#E8F5EE', baseReps:6,  baseSets:4, detail:'Overhand · elbows drive back' },
  db_row:            { name:'Single-Arm DB Row',      muscle:'back',     equip:'dumbbell',  tier:'moderate',icon:'🏹', color:'#E8F5EE', baseReps:10, baseSets:3, detail:'Per side · full stretch' },
  lat_pulldown:      { name:'Lat Pulldown',           muscle:'back',     equip:'cable',     tier:'moderate',icon:'⬇️', color:'#EDE8F5', baseReps:10, baseSets:4, detail:'Wide grip · pull to chest' },
  seated_cable_row:  { name:'Seated Cable Row',       muscle:'back',     equip:'cable',     tier:'moderate',icon:'🏹', color:'#FDE8EE', baseReps:12, baseSets:3, detail:'Close grip · full ROM' },
  chin_up:           { name:'Weighted Chin-Up',       muscle:'back',     equip:'bodyweight',tier:'heavy',   icon:'⬆️', color:'#EDE8F5', baseReps:5,  baseSets:4, detail:'Belt or DB · supinated grip' },
  pullover:          { name:'Cable Pullover',         muscle:'back',     equip:'cable',     tier:'light',   icon:'🌊', color:'#E8F5EE', baseReps:15, baseSets:3, detail:'Lats · arms straight' },
  face_pull:         { name:'Face Pull',              muscle:'back',     equip:'cable',     tier:'light',   icon:'🎯', color:'#EDE8F5', baseReps:15, baseSets:3, detail:'Rear delt · rotator cuff health' },
  barbell_bench:     { name:'Barbell Bench Press',    muscle:'chest',    equip:'barbell',   tier:'heavy',   icon:'💪', color:'#FDE8EE', baseReps:5,  baseSets:4, detail:'Flat · shoulder blades retracted' },
  incline_db_press:  { name:'Incline DB Press',       muscle:'chest',    equip:'dumbbell',  tier:'moderate',icon:'📐', color:'#FDE8EE', baseReps:10, baseSets:4, detail:'30° incline · upper chest' },
  cable_chest_fly:   { name:'Cable Chest Fly',        muscle:'chest',    equip:'cable',     tier:'light',   icon:'🦅', color:'#E8F5EE', baseReps:12, baseSets:3, detail:'Crossover · constant tension' },
  db_chest_press:    { name:'DB Flat Press',          muscle:'chest',    equip:'dumbbell',  tier:'moderate',icon:'💪', color:'#FDE8EE', baseReps:10, baseSets:3, detail:'Neutral grip option available' },
  pec_dec:           { name:'Pec Deck Machine',       muscle:'chest',    equip:'machine',   tier:'light',   icon:'🦅', color:'#FDE8EE', baseReps:15, baseSets:3, detail:'Machine · pump finish' },
  barbell_ohp:       { name:'Barbell Overhead Press', muscle:'shoulders',equip:'barbell',   tier:'heavy',   icon:'🙌', color:'#FEF3E8', baseReps:5,  baseSets:4, detail:'Standing · brace hard' },
  db_shoulder_press: { name:'DB Shoulder Press',      muscle:'shoulders',equip:'dumbbell',  tier:'moderate',icon:'🙌', color:'#FEF3E8', baseReps:10, baseSets:3, detail:'Seated · neutral or pronated' },
  lateral_raise:     { name:'Lateral Raise',          muscle:'shoulders',equip:'dumbbell',  tier:'light',   icon:'✈️', color:'#FEF3E8', baseReps:15, baseSets:3, detail:'Slight forward lean · thumbs down' },
  cable_lateral:     { name:'Cable Lateral Raise',    muscle:'shoulders',equip:'cable',     tier:'light',   icon:'✈️', color:'#FEF3E8', baseReps:15, baseSets:3, detail:'Cable · constant tension' },
  barbell_curl:      { name:'Barbell Curl',           muscle:'biceps',   equip:'barbell',   tier:'moderate',icon:'💪', color:'#FDE8EE', baseReps:10, baseSets:3, detail:'Supinated · full ROM' },
  db_bicep_curl:     { name:'DB Bicep Curl',          muscle:'biceps',   equip:'dumbbell',  tier:'light',   icon:'💪', color:'#FDE8EE', baseReps:12, baseSets:3, detail:'Alternating · slow eccentric' },
  hammer_curl:       { name:'Hammer Curl',            muscle:'biceps',   equip:'dumbbell',  tier:'light',   icon:'🔨', color:'#EDE8F5', baseReps:12, baseSets:3, detail:'Neutral grip · brachialis' },
  tricep_pushdown:   { name:'Tricep Pushdown',        muscle:'triceps',  equip:'cable',     tier:'light',   icon:'⬇️', color:'#FEF3E8', baseReps:12, baseSets:3, detail:'Rope or bar · lock out' },
  tricep_dip:        { name:'Tricep Dip',             muscle:'triceps',  equip:'bodyweight',tier:'moderate',icon:'⬇️', color:'#FEF3E8', baseReps:10, baseSets:3, detail:'Bench or parallel bars' },
  overhead_tricep:   { name:'Overhead Tricep Ext.',   muscle:'triceps',  equip:'cable',     tier:'light',   icon:'🙌', color:'#FEF3E8', baseReps:12, baseSets:3, detail:'Long head · cable or DB' },
  ab_wheel:          { name:'Ab Wheel Rollout',       muscle:'core',     equip:'bodyweight',tier:'moderate',icon:'⚙️', color:'#E8F5EE', baseReps:10, baseSets:3, detail:'Anti-extension · slow' },
  cable_crunch:      { name:'Cable Crunch',           muscle:'core',     equip:'cable',     tier:'light',   icon:'🔥', color:'#EDE8F5', baseReps:15, baseSets:3, detail:'Kneeling · loaded flex' },
  plank:             { name:'Plank Hold',             muscle:'core',     equip:'bodyweight',tier:'light',   icon:'🔥', color:'#E8F5EE', baseReps:45, baseSets:3, detail:'sec · brace hard · breathe' },
  ab_crunch_machine: { name:'Ab Crunch Machine',      muscle:'core',     equip:'machine',   tier:'light',   icon:'🔥', color:'#EDE8F5', baseReps:15, baseSets:3, detail:'Machine · controlled flex' },
  calf_raise:        { name:'Calf Raise',             muscle:'calves',   equip:'machine',   tier:'light',   icon:'⬆️', color:'#FEF3E8', baseReps:20, baseSets:3, detail:'Full stretch at bottom' },
};

// Keep legacy EXERCISES alias so existing UI code still works
const EXERCISES = Object.fromEntries(
  Object.entries(EXERCISE_DB).map(([k, v]) => [k, {
    name: v.name, detail: v.detail,
    sets: `${v.baseSets} × ${v.baseReps}`,
    icon: v.icon, color: v.color
  }])
);

// ── PROGRESSION SCHEMES ──
const PROGRESSION_SCHEMES = {
  linear:   { loadStep:2.5,  repRange:[5,5],   deloadAt:3 },
  hyper:    { loadStep:2.5,  repRange:[8,12],  deloadAt:4 },
  volume:   { loadStep:1.25, repRange:[12,15], deloadAt:4 },
  maintain: { loadStep:0,    repRange:[8,12],  deloadAt:6 },
  bw:       { loadStep:0,    repRange:[8,15],  deloadAt:5 },
};

function getExHistory(key) {
  return ((state.exerciseHistory || {})[key]) || { loads:[], reps:[], rpes:[], sessions:0 };
}
function saveExHistory(key, entry) {
  if (!state.exerciseHistory) state.exerciseHistory = {};
  const h = getExHistory(key);
  h.loads.push(entry.load); h.reps.push(entry.reps); h.rpes.push(entry.rpe); h.sessions++;
  if (h.loads.length > 12) h.loads = h.loads.slice(-12);
  if (h.rpes.length  > 12) h.rpes  = h.rpes.slice(-12);
  state.exerciseHistory[key] = h;
}
function logMusclesTrained(muscles) {
  if (!state.muscleLog) state.muscleLog = {};
  muscles.forEach(m => { state.muscleLog[m] = state.workoutsCompleted; });
}

function chooseScheme(exKey, phase, tier) {
  const ex = EXERCISE_DB[exKey];
  if (!ex) return PROGRESSION_SCHEMES.hyper;
  if (ex.equip === 'bodyweight') return PROGRESSION_SCHEMES.bw;
  if (phase === 'luteal')        return PROGRESSION_SCHEMES.maintain;
  if (phase === 'menstrual')     return PROGRESSION_SCHEMES.volume;
  if (tier === 'heavy' || ex.tier === 'heavy') return PROGRESSION_SCHEMES.linear;
  return PROGRESSION_SCHEMES.hyper;
}

function computeTarget(exKey, phase, tier) {
  const ex = EXERCISE_DB[exKey];
  if (!ex) return { load:0, reps:10, sets:3, isProgression:false, label:'' };
  const h = getExHistory(exKey);
  const scheme = chooseScheme(exKey, phase, tier);
  const seedLoads = { quads:[40,60,80], glutes:[30,50,70], hamstring:[20,35,50], back:[30,50,70], chest:[30,50,70], shoulders:[20,35,50], biceps:[10,15,20], triceps:[10,15,20], core:[0,0,0], calves:[20,30,40] };
  const level = Math.max(0, (state.level||1) - 1);
  const seed  = (seedLoads[ex.muscle] || [20,35,50])[level];
  let load = h.loads.length > 0 ? h.loads[h.loads.length-1] : seed;
  let reps = h.reps.length  > 0 ? h.reps[h.reps.length-1]  : ex.baseReps;
  const lastRPE = h.rpes.length > 0 ? h.rpes[h.rpes.length-1] : 6;
  let isProgression = false, label = '';

  if (lastRPE >= 9) {
    load = roundToPlate(load * 0.95);
    label = '↓ RPE was high — load reduced 5%';
  } else if (lastRPE <= 6 && h.sessions > 0) {
    if (scheme.loadStep > 0) {
      // Scale progression step by phase strength multiplier (ovulatory: 1.18×, menstrual: 0.85×)
      const mult = (_mlResult && _mlResult.features) ? (_mlResult.features.strength_mult || 1.0) : 1.0;
      const scaledStep = roundToPlate(scheme.loadStep * mult);
      load += scaledStep;
      isProgression = true;
      label = `↑ +${scaledStep}kg · progressive overload`;
    } else if (reps < scheme.repRange[1]) { reps++; isProgression = true; label = `↑ +1 rep · rep progression`; }
  }

  const sets = Math.max(2, Math.round(ex.baseSets * PHASES[phase].volumeScale));
  if (state.symptoms.includes('cramps')) {
    return { load: Math.max(0, roundToPlate(load * 0.80)), reps: scheme.repRange[1], sets: 2, isProgression: false, label: '🩸 Load reduced for today' };
  }
  return { load: Math.max(0, load), reps: Math.max(scheme.repRange[0], Math.min(scheme.repRange[1], reps)), sets, isProgression, label };
}

function needsDeload() {
  // 1. Classic: recent compound barbell RPE average
  const compounds = ['barbell_squat','barbell_bench','barbell_row','barbell_ohp','sumo_deadlift'];
  const compoundRPEs = compounds.flatMap(k => (getExHistory(k).rpes||[]).slice(-3));
  const compoundOverload = compoundRPEs.length >= 3 &&
    compoundRPEs.reduce((a,b)=>a+b,0) / compoundRPEs.length >= 8.5;

  // 2. Broad: high RPEs across any 6+ logged exercise sessions
  const allRPEs = Object.values(state.exerciseHistory || {}).flatMap(h => (h.rpes||[]).slice(-2));
  const broadFatigue = allRPEs.length >= 6 &&
    allRPEs.reduce((a,b)=>a+b,0) / allRPEs.length >= 8.0;

  // 3. ML fatigue signal: use cached result so we don't force a re-run
  const mlFatigue = _mlResult && _mlResult.features && _mlResult.features.fatigueAccum > 0.80;

  return compoundOverload || (broadFatigue && mlFatigue);
}

// ── SESSION TYPES ──
const SESSION_TYPES = {
  menstrual:  ['full_body_machines','upper_light','lower_light'],
  follicular: ['lower_strength','push','pull','upper_strength','full_body'],
  ovulatory:  ['lower_power','full_body_power','push_heavy','pull_heavy'],
  luteal:     ['upper_maintain','lower_maintain','full_body_light'],
};
const SESSION_META = {
  full_body_machines:{ name:'Machines Full Body',   type:'Light Gym',             emoji:'🌸', duration:'30 min', kcal:'~150', color:'linear-gradient(135deg,#F2A7B4,#C9B8E8)', tier:'light',    muscles:['quads','back','chest','core'],               exercises:{ quads:['leg_press','leg_extension'],            back:['lat_pulldown','seated_cable_row'], chest:['pec_dec','cable_chest_fly'],         core:['ab_crunch_machine','plank']     }, picksPerGroup:1 },
  upper_light:       { name:'Upper · Light',        type:'Light Upper Body',      emoji:'🌷', duration:'35 min', kcal:'~170', color:'linear-gradient(135deg,#C9B8E8,#F2A7B4)', tier:'light',    muscles:['back','chest','shoulders','biceps'],         exercises:{ back:['lat_pulldown','seated_cable_row','face_pull'],  chest:['cable_chest_fly','pec_dec'],     shoulders:['lateral_raise','cable_lateral'], biceps:['db_bicep_curl','hammer_curl'] }, picksPerGroup:1 },
  lower_light:       { name:'Lower · Light',        type:'Light Leg Day',         emoji:'🌷', duration:'35 min', kcal:'~180', color:'linear-gradient(135deg,#F2A7B4,#EDE8F5)', tier:'light',    muscles:['quads','hamstring','glutes','calves'],       exercises:{ quads:['leg_press','leg_extension','hack_squat'],     hamstring:['leg_curl_seated','leg_curl_lying'], glutes:['cable_kickback','db_hip_thrust'], calves:['calf_raise'] }, picksPerGroup:1 },
  lower_strength:    { name:'Leg Day · Build',      type:'Lower Strength',        emoji:'🏋️', duration:'50 min', kcal:'~280', color:'linear-gradient(135deg,#C9B8E8,#F9C9A3)', tier:'moderate', muscles:['quads','glutes','hamstring','calves'],       exercises:{ quads:['barbell_squat','bulgarian_squat','hack_squat','goblet_squat'], glutes:['rdl','db_rdl','walking_lunge'], hamstring:['leg_curl_seated','nordic_curl'], calves:['calf_raise'] }, picksPerGroup:{ quads:1, glutes:1, hamstring:1, calves:1 } },
  push:              { name:'Push Day',             type:'Chest · Shoulders · Tris',emoji:'💜', duration:'50 min', kcal:'~270', color:'linear-gradient(135deg,#A896D4,#C9B8E8)', tier:'moderate', muscles:['chest','shoulders','triceps'],               exercises:{ chest:['barbell_bench','incline_db_press','db_chest_press','cable_chest_fly'], shoulders:['db_shoulder_press','barbell_ohp','lateral_raise'], triceps:['tricep_pushdown','overhead_tricep','tricep_dip'] }, picksPerGroup:{ chest:2, shoulders:1, triceps:1 } },
  pull:              { name:'Pull Day',             type:'Back · Biceps',         emoji:'⚡️', duration:'55 min', kcal:'~290', color:'linear-gradient(135deg,#C9B8E8,#7A5FA8)', tier:'moderate', muscles:['back','biceps'],                             exercises:{ back:['barbell_row','db_row','lat_pulldown','seated_cable_row','chin_up','pullover','face_pull'], biceps:['barbell_curl','db_bicep_curl','hammer_curl'] }, picksPerGroup:{ back:3, biceps:2 } },
  upper_strength:    { name:'Upper Strength',       type:'Heavy Push + Pull',     emoji:'💪', duration:'55 min', kcal:'~310', color:'linear-gradient(135deg,#A896D4,#F9C9A3)', tier:'heavy',    muscles:['chest','back','shoulders'],                  exercises:{ chest:['barbell_bench','incline_db_press'], back:['barbell_row','chin_up','lat_pulldown'], shoulders:['barbell_ohp','db_shoulder_press','lateral_raise'] }, picksPerGroup:{ chest:1, back:2, shoulders:1 } },
  full_body:         { name:'Full Body Build',      type:'Full Body · Strength',  emoji:'🌟', duration:'55 min', kcal:'~300', color:'linear-gradient(135deg,#C9B8E8,#F9C9A3)', tier:'moderate', muscles:['quads','back','chest','glutes','core'],      exercises:{ quads:['barbell_squat','goblet_squat','leg_press'], back:['barbell_row','lat_pulldown','seated_cable_row'], chest:['barbell_bench','incline_db_press'], glutes:['rdl','barbell_hip_thrust'], core:['ab_wheel','cable_crunch'] }, picksPerGroup:{ quads:1, back:1, chest:1, glutes:1, core:1 } },
  lower_power:       { name:'Heavy Lower',          type:'Leg Day · Power',       emoji:'💪', duration:'50 min', kcal:'~320', color:'linear-gradient(135deg,#F9C9A3,#F0A873)', tier:'heavy',    muscles:['quads','glutes','hamstring'],                exercises:{ quads:['barbell_squat','front_squat','bulgarian_squat'], glutes:['barbell_hip_thrust','sumo_deadlift','rdl'], hamstring:['leg_curl_lying','nordic_curl'] }, picksPerGroup:{ quads:1, glutes:1, hamstring:1 } },
  full_body_power:   { name:'Full Body Power',      type:'Peak Strength Day',     emoji:'🌟', duration:'60 min', kcal:'~370', color:'linear-gradient(135deg,#F0A873,#F9C9A3)', tier:'heavy',    muscles:['quads','back','chest','glutes','shoulders'], exercises:{ quads:['barbell_squat'], back:['barbell_row','chin_up'], chest:['barbell_bench'], glutes:['rdl','barbell_hip_thrust'], shoulders:['barbell_ohp'] }, picksPerGroup:{ quads:1, back:1, chest:1, glutes:1, shoulders:1 } },
  push_heavy:        { name:'Heavy Push',           type:'PR Chest & Shoulders',  emoji:'🏆', duration:'60 min', kcal:'~350', color:'linear-gradient(135deg,#F0A873,#E88040)', tier:'heavy',    muscles:['chest','shoulders','triceps'],               exercises:{ chest:['barbell_bench','incline_db_press'], shoulders:['barbell_ohp','lateral_raise'], triceps:['tricep_pushdown','overhead_tricep'] }, picksPerGroup:{ chest:2, shoulders:1, triceps:1 } },
  pull_heavy:        { name:'Heavy Pull',           type:'PR Back & Biceps',      emoji:'🏆', duration:'60 min', kcal:'~350', color:'linear-gradient(135deg,#E88040,#F9C9A3)', tier:'heavy',    muscles:['back','biceps'],                             exercises:{ back:['barbell_row','chin_up','lat_pulldown','face_pull'], biceps:['barbell_curl','hammer_curl'] }, picksPerGroup:{ back:3, biceps:2 } },
  upper_maintain:    { name:'Upper · Maintain',     type:'Push + Pull · Moderate',emoji:'🍂', duration:'45 min', kcal:'~230', color:'linear-gradient(135deg,#8CBF9C,#B8D4C0)', tier:'moderate', muscles:['chest','back','shoulders','biceps','triceps'],exercises:{ chest:['incline_db_press','cable_chest_fly'], back:['lat_pulldown','seated_cable_row'], shoulders:['lateral_raise','db_shoulder_press'], biceps:['db_bicep_curl'], triceps:['tricep_pushdown'] }, picksPerGroup:1 },
  lower_maintain:    { name:'Lower · Maintain',     type:'Leg Day · Moderate',    emoji:'🌿', duration:'40 min', kcal:'~210', color:'linear-gradient(135deg,#B8D4C0,#8CBF9C)', tier:'moderate', muscles:['quads','glutes','hamstring'],                exercises:{ quads:['leg_press','goblet_squat','bulgarian_squat'], glutes:['db_hip_thrust','db_rdl'], hamstring:['leg_curl_seated'] }, picksPerGroup:1 },
  full_body_light:   { name:'Full Body · Light',    type:'Moderate Full Body',    emoji:'🌱', duration:'45 min', kcal:'~240', color:'linear-gradient(135deg,#B8D4C0,#C9B8E8)', tier:'light',    muscles:['quads','back','chest','glutes','core'],      exercises:{ quads:['goblet_squat','leg_press'], back:['lat_pulldown','seated_cable_row'], chest:['db_chest_press','cable_chest_fly'], glutes:['db_rdl','walking_lunge'], core:['plank','cable_crunch'] }, picksPerGroup:1 },
};

// ── WORKOUT SPLITS — female aesthetics focus ──────────────────────────────
// Priority: Glutes > Legs (Quads + Hamstrings) > Back > Core/Abs > Shoulders > Arms
// Chest is treated as minor accessory only. Every day includes core work.
const WORKOUT_SPLITS = {
  2: {
    name: '2-Day Split', focus: 'Glutes · Legs · Back', emoji: '🍑',
    days: [
      { name: 'Glutes & Legs', emoji: '🍑', tag: 'Hip Thrust · Squat · RDL · Abs',
        exercises: ['barbell_hip_thrust','barbell_squat','rdl','leg_curl_seated','cable_kickback','ab_wheel','cable_crunch'] },
      { name: 'Back & Hamstrings', emoji: '🏹', tag: 'Row · Pulldown · RDL · Abs · Calves',
        exercises: ['barbell_row','lat_pulldown','db_row','face_pull','leg_curl_lying','plank','calf_raise'] },
    ]
  },
  3: {
    name: '3-Day Split', focus: 'Glutes · Back · Legs', emoji: '🌸',
    days: [
      { name: 'Glutes & Quads', emoji: '🍑', tag: 'Hip Thrust · Squat · Bulgarian · Kickback · Abs',
        exercises: ['barbell_hip_thrust','barbell_squat','bulgarian_squat','cable_kickback','leg_extension','ab_wheel','cable_crunch'] },
      { name: 'Back & Core', emoji: '🏹', tag: 'Row · Pulldown · Chin-Up · Face Pull · Abs',
        exercises: ['barbell_row','lat_pulldown','db_row','seated_cable_row','face_pull','ab_crunch_machine','plank'] },
      { name: 'Hamstrings & Glutes', emoji: '🔄', tag: 'RDL · Sumo · Leg Curl · Hip Thrust · Abs',
        exercises: ['rdl','sumo_deadlift','leg_curl_lying','db_hip_thrust','nordic_curl','cable_crunch','calf_raise'] },
    ]
  },
  4: {
    name: '4-Day Split', focus: 'Glutes · Back · Legs · Core', emoji: '💜',
    days: [
      { name: 'Glutes A & Quads', emoji: '🍑', tag: 'Hip Thrust · Squat · Leg Press · Abs',
        exercises: ['barbell_hip_thrust','barbell_squat','bulgarian_squat','leg_press','cable_kickback','ab_wheel','cable_crunch'] },
      { name: 'Back A & Core', emoji: '🏹', tag: 'Row · Pulldown · Chin-Up · Face Pull · Abs',
        exercises: ['barbell_row','lat_pulldown','chin_up','seated_cable_row','face_pull','ab_crunch_machine','plank'] },
      { name: 'Hamstrings & Glutes B', emoji: '🔄', tag: 'RDL · Sumo · Leg Curl · Hip Thrust · Abs',
        exercises: ['rdl','sumo_deadlift','leg_curl_lying','db_hip_thrust','nordic_curl','cable_crunch','calf_raise'] },
      { name: 'Back B & Legs', emoji: '⬇️', tag: 'Row · Pullover · Hack Squat · Lunge · Abs',
        exercises: ['db_row','pullover','hack_squat','walking_lunge','leg_extension','ab_wheel','plank'] },
    ]
  },
  5: {
    name: '5-Day Split', focus: 'Glutes · Back · Legs · Abs', emoji: '🌟',
    days: [
      { name: 'Glutes A & Quads', emoji: '🍑', tag: 'Hip Thrust · Squat · Leg Press · Abs',
        exercises: ['barbell_hip_thrust','barbell_squat','bulgarian_squat','leg_press','cable_kickback','leg_extension','cable_crunch'] },
      { name: 'Back A & Core', emoji: '🏹', tag: 'Row · Pulldown · Chin-Up · Face Pull · Abs',
        exercises: ['barbell_row','lat_pulldown','chin_up','db_row','face_pull','ab_wheel','plank'] },
      { name: 'Hamstrings & Glutes B', emoji: '🔄', tag: 'RDL · Sumo · Leg Curl · Lunge · Abs',
        exercises: ['rdl','sumo_deadlift','leg_curl_lying','db_hip_thrust','nordic_curl','walking_lunge','cable_crunch'] },
      { name: 'Back B & Abs', emoji: '⬇️', tag: 'Row · Pullover · Seated Row · Abs · Calves',
        exercises: ['db_row','seated_cable_row','pullover','ab_crunch_machine','ab_wheel','cable_crunch','calf_raise'] },
      { name: 'Legs & Core', emoji: '🦵', tag: 'Hack Squat · Goblet · Leg Curl · Abs · Calves',
        exercises: ['hack_squat','goblet_squat','leg_curl_seated','cable_kickback','plank','ab_wheel','calf_raise'] },
    ]
  },
  6: {
    name: '6-Day Split', focus: 'Glutes · Back · Legs · Abs', emoji: '🏆',
    days: [
      { name: 'Glutes A & Quads', emoji: '🍑', tag: 'Hip Thrust · Squat · Bulgarian · Kickback · Abs',
        exercises: ['barbell_hip_thrust','barbell_squat','bulgarian_squat','cable_kickback','leg_extension','cable_crunch'] },
      { name: 'Back A & Core', emoji: '🏹', tag: 'Row · Pulldown · Chin-Up · Face Pull · Abs',
        exercises: ['barbell_row','lat_pulldown','chin_up','face_pull','ab_wheel','plank'] },
      { name: 'Hamstrings & Glutes B', emoji: '🔄', tag: 'RDL · Sumo · Leg Curl · Hip Thrust',
        exercises: ['rdl','sumo_deadlift','leg_curl_lying','db_hip_thrust','nordic_curl','cable_crunch'] },
      { name: 'Back B & Abs', emoji: '⬇️', tag: 'DB Row · Seated Row · Pullover · Abs',
        exercises: ['db_row','seated_cable_row','pullover','ab_crunch_machine','ab_wheel','calf_raise'] },
      { name: 'Legs & Core', emoji: '🦵', tag: 'Hack Squat · Leg Press · Goblet · Lunge · Abs',
        exercises: ['hack_squat','leg_press','goblet_squat','walking_lunge','plank','cable_crunch'] },
      { name: 'Glutes C & Abs', emoji: '✨', tag: 'DB Hip Thrust · DB RDL · Kickback · Abs · Calves',
        exercises: ['db_hip_thrust','db_rdl','cable_kickback','leg_curl_seated','ab_crunch_machine','ab_wheel','calf_raise'] },
    ]
  },
};

function selectSessionType(phase, tier) {
  const available = SESSION_TYPES[phase] || SESSION_TYPES.follicular;
  const trained = state.muscleLog || {};
  const current = state.workoutsCompleted;
  const focus = state.focusMuscles || [];
  const freshness = m => current - (trained[m] || 0);

  const scored = available.map(t => {
    const meta = SESSION_META[t];
    const freshnessScore = meta.muscles.reduce((s,m) => s + freshness(m), 0) / meta.muscles.length;
    // Bonus score if session hits user's focus muscles
    const focusBonus = focus.length > 0
      ? meta.muscles.filter(m => focus.some(f => m.includes(f) || f.includes(m))).length * 3
      : 0;
    return { type: t, score: freshnessScore + focusBonus };
  }).sort((a,b) => b.score - a.score);

  if (tier === 'low') {
    const light = scored.filter(s => SESSION_META[s.type].tier === 'light');
    if (light.length) return light[0].type;
  }
  return scored[0].type;
}

function pickExercises(sessionMeta, phase, tier) {
  const picks = [];
  // Penalise exercises done last session to encourage variety
  const lastDone = new Set(state.lastWorkoutExercises || []);
  const ppg = typeof sessionMeta.picksPerGroup === 'object'
    ? sessionMeta.picksPerGroup
    : Object.fromEntries(sessionMeta.muscles.map(m => [m, sessionMeta.picksPerGroup || 1]));
  for (const muscle of sessionMeta.muscles) {
    const pool = (sessionMeta.exercises[muscle] || []).filter(k => EXERCISE_DB[k]);
    const n = ppg[muscle] || 1;
    // Sort by sessions done, but add a 4-session penalty for last-workout exercises
    const sorted = pool.slice().sort((a,b) => {
      const penA = lastDone.has(a) ? 4 : 0;
      const penB = lastDone.has(b) ? 4 : 0;
      return ((getExHistory(a).sessions||0) + penA) - ((getExHistory(b).sessions||0) + penB);
    });
    const candidates = sorted.slice(0, Math.min(n+2, sorted.length));
    for (let i = 0; i < n && candidates.length > 0; i++) {
      // 50% chance of picking the second-best candidate (was 35%) for more variety
      const idx = Math.random() < 0.50 && candidates.length > 1 ? 1 : 0;
      picks.push(candidates.splice(idx, 1)[0]);
    }
  }
  return picks;
}

function generatePlan(phase, tier) {
  phase = phase || state.phase || 'follicular';
  tier  = tier  || 'medium';
  if (!PHASES[phase]) phase = 'follicular';
  if (needsDeload()) tier = 'low';
  const sessionType = selectSessionType(phase, tier);
  const meta = SESSION_META[sessionType] || SESSION_META['full_body'];
  const exKeys = pickExercises(meta, phase, tier);

  // Order exercises: heavy compounds first, then moderate, then light accessories
  const tierOrder = { heavy: 0, moderate: 1, light: 2 };
  exKeys.sort((a, b) => (tierOrder[EXERCISE_DB[a]?.tier] ?? 1) - (tierOrder[EXERCISE_DB[b]?.tier] ?? 1));

  const phaseScale = (PHASES[phase] && PHASES[phase].volumeScale) || 1.0;

  // Apply user's chosen session duration scale (from onboarding)
  const durationScale = (state.durationScale || 1.0) * phaseScale;
  const durationMins = Math.round((parseInt(meta.duration) || 45) * durationScale);
  const kcalBase = parseInt(meta.kcal) || 250;

  // Phase + cycle-aware reason strings
  const phaseReasons = {
    menstrual:  { low:'"Estrogen is low — light work is the right call today. You showed up 💕"', medium:'"Light work in your menstrual phase builds consistency without the cost. 🌸"', high:'"Even with high energy, protecting this phase pays off next week. 💕"' },
    follicular: { low:'"Energy is building — a focused session sets the tone for the week. 💜"', medium:'"Estrogen rising — your coordination is sharp. Great time to add load. ⚡️"', high:'"You\'re thriving — estrogen is climbing. Push for a new challenge. 🌟"' },
    ovulatory:  { low:'"Even a moderate session in your peak window is more productive than usual. 💪"', medium:'"You\'re in your peak window — let\'s make the most of it! ⚡️"', high:'"Top energy + peak phase. Today was made for a personal record. 🏆"' },
    luteal:     { low:'"Your body\'s asking for gentleness today — this is the smartest choice. 🍃"', medium:'"Maintaining your strength this week locks in what you built. Solid. 🌿"', high:'"Keeping intensity moderate in luteal protects your next peak window. 🌱"' },
  };
  const reason = (phaseReasons[phase] || phaseReasons.follicular)[tier] || '"Solid session ahead. 🌸"';

  // Volume modifier from ML pipeline (e.g. +20 for PR_WINDOW, -25 for RECOVERY)
  const volumeMod = (_mlResult && _mlResult.modifier) ? (_mlResult.modifier.volumeMod || 0) : 0;

  // Build enriched exercise entries with progression data
  const exerciseEntries = exKeys.map(key => {
    const ex = EXERCISE_DB[key];
    const target = computeTarget(key, phase, tier);
    if (!ex) return null;
    // Apply ML volumeMod to set count, keeping minimum 2
    const rawSets = Math.max(2, Math.round(target.sets * (1 + volumeMod / 100)));
    const repsLabel = ex.muscle === 'core' && ex.name.includes('Plank') ? `${target.reps} sec` : `${target.reps}`;
    return { ...ex, key, sets:`${rawSets} × ${repsLabel}`, targetLoad:target.load, isProgression:target.isProgression, progressionLabel:target.label };
  }).filter(Boolean);

  return {
    key: sessionType,
    name: meta.name,
    type: meta.type,
    emoji: meta.emoji,
    duration: `${durationMins} min`,
    intensity: { light:'Low', moderate:'Medium', heavy:'High', max:'Maximal' }[meta.tier] || 'Medium',
    kcal: `~${Math.round(kcalBase * durationScale)} kcal`,
    reason,
    color: meta.color,
    exercises: exKeys,
    exerciseEntries,
    musclesToLog: meta.muscles,
  };
}

// ═══════════════════════════════════════════
// PERSONAL CYCLE MODEL
// ═══════════════════════════════════════════

// ── Compute current cycle day from last period start date ──
function getCycleDay() {
  if (!state.cycle.lastPeriodStart) return state.cycleDay || 14;
  const start = new Date(state.cycle.lastPeriodStart);
  const today = new Date();
  const diffDays = Math.floor((today - start) / MS_PER_DAY);
  // Cap at cycle length — never auto-wrap into menstrual; only recordPeriodStart() can do that
  return Math.min(diffDays + 1, state.cycle.cycleLength || 28);
}

// ── Derive phase from cycle day + personal phase lengths ──
function getPhaseFromDay(cycleDay) {
  const pl = state.cycle.phaseLengths;
  if (cycleDay <= pl.menstrual)                                    return 'menstrual';
  if (cycleDay <= pl.menstrual + pl.follicular)                    return 'follicular';
  if (cycleDay <= pl.menstrual + pl.follicular + pl.ovulatory)     return 'ovulatory';
  return 'luteal';
}

// Legacy alias used throughout the app
function getPhase(cycleDay) { return getPhaseFromDay(cycleDay); }

// ── Symptom-based phase inference ──
function inferPhaseFromSymptoms(symptoms) {
  if (!symptoms || symptoms.length === 0) return null;
  const weights = (state.cycle && state.cycle.symptomWeights) || {};
  const phases = ['menstrual','follicular','ovulatory','luteal'];
  const scores = { menstrual:1, follicular:1, ovulatory:1, luteal:1 };
  symptoms.forEach(sym => {
    const w = weights[sym];
    if (!w) return;
    phases.forEach(p => { scores[p] *= (w[p] || 0.1); });
  });
  const total = phases.reduce((s,p) => s + scores[p], 0);
  if (total === 0) return null;
  return Object.fromEntries(phases.map(p => [p, scores[p] / total]));
}

// ── Blend calendar model with symptom inference ──
function getBlendedPhase() {
  const cycleDay = getCycleDay();
  const calPhase = getPhaseFromDay(cycleDay);
  const symptoms = state.symptoms || [];
  const confidence = (state.cycle && state.cycle.confidence) || 0.4;

  if (symptoms.length === 0 || confidence > 0.85) return calPhase;

  const sympProbs = inferPhaseFromSymptoms(symptoms);
  if (!sympProbs) return calPhase;

  const calWeight  = 0.5 + confidence * 0.4;
  const sympWeight = 1 - calWeight;
  const phases = ['menstrual','follicular','ovulatory','luteal'];
  const calProbs = { menstrual:0, follicular:0, ovulatory:0, luteal:0 };
  calProbs[calPhase] = 1;

  const blended = {};
  phases.forEach(p => { blended[p] = calWeight * calProbs[p] + sympWeight * sympProbs[p]; });
  return phases.reduce((a, b) => blended[a] > blended[b] ? a : b);
}

// ── Record a new period start — the key learning event ──
function recordPeriodStart() {
  const today = new Date().toISOString().split('T')[0];

  // Learn cycle length from gap between this and last period
  if (state.cycle.periodHistory.length > 0) {
    const last = new Date(state.cycle.periodHistory[state.cycle.periodHistory.length - 1]);
    const gapDays = Math.round((new Date(today) - last) / MS_PER_DAY);

    if (gapDays >= 20 && gapDays <= 45) {
      // Valid cycle — update learned cycle length with exponential smoothing
      const alpha = 0.3; // learning rate — 0.3 means new data weighted 30%
      state.cycle.cycleLength = Math.round(
        alpha * gapDays + (1 - alpha) * (state.cycle.cycleLength || 28)
      );

      // Learn luteal length: what came before this period start is luteal
      // Estimate: cycleLength - (menstrual + follicular + ovulatory)
      const nonLuteal = state.cycle.phaseLengths.menstrual +
                        state.cycle.phaseLengths.follicular +
                        state.cycle.phaseLengths.ovulatory;
      state.cycle.phaseLengths.luteal = Math.max(
        7,
        Math.round(alpha * (state.cycle.cycleLength - nonLuteal) +
                   (1 - alpha) * state.cycle.phaseLengths.luteal)
      );

      // Increase confidence with each confirmed cycle
      state.cycle.confidence = Math.min(0.95, state.cycle.confidence + 0.12);
    }
  }

  // Also update learned menstrual length based on period tracking
  // If user taps "period started" then next day taps "period ended" (via symptom removal)
  // we'd learn bleed duration — for now default to 5 and let symptom model refine
  state.cycle.phaseLengths.follicular = Math.max(
    5, state.cycle.cycleLength
      - state.cycle.phaseLengths.menstrual
      - state.cycle.phaseLengths.ovulatory
      - state.cycle.phaseLengths.luteal
  );

  // Update symptom weights: reinforce symptoms logged during menstrual
  const recentSymptoms = (state.moodHistory || []).slice(-5)
    .flatMap(h => h.symptoms || []);
  recentSymptoms.forEach(sym => {
    if (!state.cycle.symptomWeights[sym]) {
      state.cycle.symptomWeights[sym] = { menstrual:0.5, follicular:0.2, ovulatory:0.2, luteal:0.5 };
    }
    const w = state.cycle.symptomWeights[sym];
    // Reinforce: this symptom was present before period → menstrual signal
    w.menstrual = Math.min(0.95, w.menstrual + 0.05);
  });

  // Store the period date
  state.cycle.periodHistory.push(today);
  if (state.cycle.periodHistory.length > 12) {
    state.cycle.periodHistory = state.cycle.periodHistory.slice(-12);
  }
  state.cycle.lastPeriodStart = today;

  // Recompute current state
  state.cycleDay = 1;
  state.phase = 'menstrual';
  invalidateML();
  saveState();
}

// ── Advance cycle day each day ──
function advanceCycleDay() {
  state.cycleDay = getCycleDay();
  state.phase    = getBlendedPhase();
}

// ── Try Apple Health / Google Fit for cycle data ──
async function tryHealthKitSync() {
  // Web-based Health API (Chrome on Android via Health Connect, or iOS Safari via HealthKit bridge)
  // Check if the browser Health API is available
  if ('health' in navigator) {
    try {
      const perms = await navigator.health.requestPermission([
        { name: 'menstruation', access: 'read' }
      ]);
      if (perms.some(p => p.name === 'menstruation' && p.granted)) {
        const records = await navigator.health.query({
          type: 'menstruation',
          startTime: new Date(Date.now() - 90 * MS_PER_DAY).toISOString(),
          endTime:   new Date().toISOString(),
        });
        if (records && records.length > 0) {
          // Sort by date, use most recent period start
          records.sort((a,b) => new Date(a.startTime) - new Date(b.startTime));
          records.forEach(r => {
            const d = r.startTime.split('T')[0];
            if (!state.cycle.periodHistory.includes(d)) {
              state.cycle.periodHistory.push(d);
            }
          });
          state.cycle.periodHistory.sort();
          state.cycle.lastPeriodStart = state.cycle.periodHistory[state.cycle.periodHistory.length - 1];
          state.cycle.healthKitLinked = true;
          state.cycle.confidence = Math.max(state.cycle.confidence, 0.75);
          // Learn cycle lengths from history
          if (state.cycle.periodHistory.length >= 2) {
            const gaps = [];
            for (let i = 1; i < state.cycle.periodHistory.length; i++) {
              const g = Math.round(
                (new Date(state.cycle.periodHistory[i]) - new Date(state.cycle.periodHistory[i-1])) / MS_PER_DAY
              );
              if (g >= 20 && g <= 45) gaps.push(g);
            }
            if (gaps.length > 0) {
              state.cycle.cycleLength = Math.round(gaps.reduce((a,b)=>a+b,0) / gaps.length);
            }
          }
          advanceCycleDay();
          saveState();
          return true;
        }
      }
    } catch(e) {
      // Health API not available or denied — silent fail
    }
  }
  return false;
}

// ═══════════════════════════════════════════
// ML ENGINE — BLOOM ADAPTIVE SYSTEM
// ═══════════════════════════════════════════

// Feature computation from state
function computeFeatures() {
  // Safety: ensure cycle object exists before calling advanceCycleDay
  if (state.cycle && state.cycle.lastPeriodStart) {
    advanceCycleDay();
  } else if (!state.phase) {
    state.phase = getPhase(state.cycleDay || 14);
  }
  const phase = state.phase || 'follicular';
  const phaseIdx = { menstrual:0, follicular:1, ovulatory:2, luteal:3 }[phase] ?? 1;
  const cycleDay = state.cycleDay || getCycleDay();
  const confidence = (state.cycle && state.cycle.confidence) || 0.4;

  // Hormone proxies (inferred from phase + day)
  const hormoneProxies = {
    menstrual:   { estrogen: 0.15, progesterone: 0.10, lh_surge: 0.0,  strength_mult: 0.85 },
    follicular:  { estrogen: 0.65, progesterone: 0.15, lh_surge: 0.15, strength_mult: 1.05 },
    ovulatory:   { estrogen: 0.95, progesterone: 0.25, lh_surge: 0.88, strength_mult: 1.18 },
    luteal:      { estrogen: 0.40, progesterone: 0.80, lh_surge: 0.05, strength_mult: 0.95 },
  };
  const hormones = hormoneProxies[phase];

  // ACWR — rolling 28-day workout dates for an accurate chronic:acute ratio
  const recentDates = state.recentWorkoutDates || [];
  const now7  = new Date(Date.now() -  7 * MS_PER_DAY).toISOString().split('T')[0];
  const now28 = new Date(Date.now() - 28 * MS_PER_DAY).toISOString().split('T')[0];
  const doneThisWeek  = recentDates.filter(d => d > now7).length;
  const doneLast28    = recentDates.filter(d => d >= now28).length;
  const weeklyAvg     = doneLast28 / 4;
  const acwr = weeklyAvg > 0 ? (doneThisWeek / weeklyAvg) : (doneThisWeek > 0 ? 1.0 : 0.5);

  // Fatigue accumulation index (0–1): rises with recent load + low energy
  const recentLoad = Math.min(doneThisWeek * 0.18, 0.8);
  const energyPenalty = (10 - state.energy) / 10 * 0.4;
  const fatigueAccum = Math.min(0.95, recentLoad + energyPenalty);

  // Skip rate — rolling 14-day adherence vs target
  const scheduledLast14 = (state.trainingDaysPerWeek || 3) * 2;
  const now14 = new Date(Date.now() - 14 * MS_PER_DAY).toISOString().split('T')[0];
  const doneLast14 = recentDates.filter(d => d >= now14).length;
  const skipRate = Math.max(0, 1 - doneLast14 / scheduledLast14);

  // 7-day mood average (use current mood as proxy if no history)
  const moodHistory = state.moodHistory.slice(-7).map(m => m.mood);
  const mood7dAvg = moodHistory.length > 0
    ? moodHistory.reduce((a,b) => a+b, 0) / moodHistory.length
    : state.mood;

  // Energy trend: slope of last 7 energy readings (-1 = falling, +1 = rising)
  const recentEnergies = (state.moodHistory || []).slice(-7).map(e => e.energy).filter(v => v != null);
  let energyTrend = 0;
  if (recentEnergies.length >= 3) {
    const mid   = Math.floor(recentEnergies.length / 2);
    const early = recentEnergies.slice(0, mid).reduce((a,b)=>a+b,0) / mid;
    const late  = recentEnergies.slice(-mid).reduce((a,b)=>a+b,0) / mid;
    energyTrend = Math.max(-1, Math.min(1, (late - early) / 10));
  }

  // Energy delta vs naive baseline of 6
  const energyDelta = state.energy - 6;

  // Symptom severity
  const symptomScore = state.symptoms.length * 0.2;
  const hasCramps = state.symptoms.includes('cramps');

  return {
    phase, phaseIdx,
    energy: state.energy,
    mood: state.mood,
    mood7dAvg,
    energyDelta,
    energyTrend,
    fatigueAccum,
    acwr: Math.round(acwr * 100) / 100,
    skipRate,
    symptomScore,
    hasCramps,
    ...hormones,
  };
}

// Model 1: Readiness Scorer (GBT proxy)
// Weighted feature combination → readiness score 0–100
function scoreReadiness(f) {
  // Safety hard-rules first
  if (f.hasCramps) return { score: 18, confidence: 0.95, topFeatures: ['cramp_flag','phase_onehot','energy'] };

  // Feature weights (tuned to cycle physiology)
  const w = {
    estrogen:     0.18,  // phase-based hormonal readiness
    lh_surge:     0.12,  // ovulatory peak signal
    energy_norm:  0.20,  // today's energy rating
    mood_norm:    0.12,  // today's mood rating
    energy_trend: 0.08,  // 7-day energy trajectory (rising vs falling)
    fatigue_inv:  0.18,  // inverted — high fatigue = low readiness
    acwr_penalty: 0.09,  // penalise if ACWR > 1.3
    skip_penalty: 0.05,  // penalise low adherence
  };

  const energy_norm  = f.energy / 10;
  const mood_norm    = f.mood / 5;
  const fatigue_inv  = 1 - f.fatigueAccum;
  const acwr_penalty = f.acwr > 1.3 ? (f.acwr - 1.3) * 0.5 : 0;
  const skip_penalty = f.skipRate * 0.3;
  const energy_trend = f.energyTrend || 0;  // already normalised -1 to +1

  const raw =
    w.estrogen     * f.estrogen +
    w.lh_surge     * f.lh_surge +
    w.energy_norm  * energy_norm +
    w.mood_norm    * mood_norm +
    w.energy_trend * energy_trend +
    w.fatigue_inv  * fatigue_inv -
    w.acwr_penalty * acwr_penalty -
    w.skip_penalty * skip_penalty;

  const score = Math.round(Math.max(5, Math.min(98, raw * 100)));

  // SHAP-style attribution: which features contributed most
  const trendLabel = energy_trend > 0.05 ? 'Energy trend ↑' : energy_trend < -0.05 ? 'Energy trend ↓' : 'Energy trend →';
  const contributions = [
    { name: 'Energy today',        value: w.energy_norm  * energy_norm,                 color: 'var(--peach)' },
    { name: 'Mood score',          value: w.mood_norm    * mood_norm,                   color: 'var(--lilac)' },
    { name: 'Estrogen level',      value: w.estrogen     * f.estrogen,                  color: 'var(--rose)'  },
    { name: 'Fatigue index',       value: w.fatigue_inv  * fatigue_inv,                 color: 'var(--sage)'  },
    { name: 'LH surge (ovulation)',value: w.lh_surge     * f.lh_surge,                  color: 'var(--peach)' },
    { name: 'Workload (ACWR)',     value: Math.max(0, 0.15 - acwr_penalty),             color: 'var(--lilac)' },
    { name: trendLabel,            value: w.energy_trend * Math.max(0, energy_trend),   color: 'var(--sage)'  },
  ].sort((a,b) => b.value - a.value);

  return { score, confidence: 0.82 + Math.random() * 0.12, contributions };
}

// Model 3: Adaptive Modifier (Contextual Bandit proxy)
// Maps readiness + phase → action (volume tier, intensity, session type)
function adaptModifier(readiness, f) {
  // Hard safety rules (override bandit)
  if (f.hasCramps || readiness.score < 20)     return { tier: 'low',    volumeMod: -30, intensityLabel: 'Low',      action: 'SAFETY_OVERRIDE' };
  if (f.acwr > 1.5)                             return { tier: 'low',    volumeMod: -25, intensityLabel: 'Low',      action: 'DELOAD_ACWR' };
  if (f.skipRate > 0.55)                        return { tier: 'low',    volumeMod: -20, intensityLabel: 'Low–Med',  action: 'SKIP_PATTERN' };

  // Bandit policy table
  if (readiness.score >= 80 && f.phase === 'ovulatory') return { tier: 'high',   volumeMod: +20, intensityLabel: 'Maximal',   action: 'PR_WINDOW' };
  if (readiness.score >= 70 && f.phase === 'follicular') return { tier: 'high',  volumeMod: +10, intensityLabel: 'High',      action: 'PROGRESSIVE_OVERLOAD' };
  if (readiness.score >= 65)                             return { tier: 'medium', volumeMod:   0, intensityLabel: 'Medium',    action: 'MAINTAIN' };
  if (readiness.score >= 40)                             return { tier: 'medium', volumeMod: -10, intensityLabel: 'Med–Low',   action: 'SLIGHT_REDUCE' };
  return                                                        { tier: 'low',    volumeMod: -25, intensityLabel: 'Low',       action: 'RECOVERY' };
}

// Explainability: map top SHAP features + action → human copy
const COPY_TEMPLATES = {
  SAFETY_OVERRIDE:      (f) => `Cramps are logged and your energy is ${f.energy}/10. Your body is working hard on its own today — we've switched to a very light session. Rest is always an option too. 🌹`,
  DELOAD_ACWR:          (f) => `Your training load is accumulating — backing off now prevents injury and protects your next peak window. Bloom reduced today's volume automatically. 🍃`,
  SKIP_PATTERN:         (f) => `Life got busy — no judgement. Bloom adjusted expectations and made today's session shorter and more manageable. Even showing up counts. 💕`,
  PR_WINDOW:            (f) => `Estrogen and LH are peaking — this is your physical peak. Energy is strong. Today is the ideal day to go heavy or attempt a personal record. ⚡️`,
  PROGRESSIVE_OVERLOAD: (f) => `Estrogen is rising and your energy is strong (${f.energy}/10). Follicular phase is your best window for adding load. Bloom added a progressive overload suggestion. 💜`,
  MAINTAIN:             (f) => `Solid readiness today. Bloom's keeping the plan as-is — consistent, quality work is exactly what builds long-term strength. 🌸`,
  SLIGHT_REDUCE:        (f) => f.energy >= 7
    ? `You're in your ${f.phase} phase — Bloom slightly reduced volume to match your cycle's natural rhythm. Quality over quantity today. 💕`
    : `Energy is a little lower today (${f.energy}/10). Bloom slightly reduced volume to keep the session sustainable without sacrificing consistency. 💕`,
  RECOVERY:             (f) => f.energy >= 7
    ? `You're in your ${f.phase} phase and recovery is the priority this week. Bloom shifted to a lighter session to protect your next peak window. 🍃`
    : `Your energy is ${f.energy}/10 — recovery is the priority. Bloom swapped to a lighter session to protect the gains you made earlier. 🍃`,
};

// Main ML pipeline: compute all signals → return decision object
function runMLPipeline() {
  const features    = computeFeatures();
  const readiness   = scoreReadiness(features);
  const modifier    = adaptModifier(readiness, features);
  const copyFn      = COPY_TEMPLATES[modifier.action] || COPY_TEMPLATES.MAINTAIN;
  const explanation = copyFn(features);
  return { features, readiness, modifier, explanation };
}

// Cached pipeline result (recomputed on check-in / phase change)
let _mlResult = null;
function getMLResult() {
  if (!_mlResult) _mlResult = runMLPipeline();
  return _mlResult;
}
function invalidateML() { _mlResult = null; }

function getWorkout() {
  // Ensure phase is set before generating plan
  if (!state.phase) advanceCycleDay();
  const ml = getMLResult();
  if (!ml._generatedPlan) {
    const phase = state.phase || 'follicular';
    ml._generatedPlan = generatePlan(phase, ml.modifier.tier);
  }
  return ml._generatedPlan;
}


function updateStatusTime() {
  const now = new Date();
  const h = now.getHours();
  const m = now.getMinutes().toString().padStart(2,'0');
  document.getElementById('status-time').textContent = `${h}:${m}`;
}


// ═══════════════════════════════════════════
// NAVIGATION
// ═══════════════════════════════════════════
function goTo(screenName, dir = 'right') {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active','slide-in','slide-in-left'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  const screen = document.getElementById('screen-' + screenName);
  if (!screen) return;
  screen.classList.add('active');
  screen.classList.add(dir === 'right' ? 'slide-in' : 'slide-in-left');
  screen.scrollTop = 0;
  const navBtn = document.getElementById('nav-' + screenName);
  if (navBtn) navBtn.classList.add('active');
  if (screenName === 'today')   renderToday();
  if (screenName === 'workout') renderWorkout();
  if (screenName === 'progress') renderProgress();
  if (screenName === 'photos')  renderPhotosGallery();
  if (screenName === 'learn')   renderLearnCards();
  if (screenName === 'ml')      renderML();
}

function toggleML(key, val) {
  state['ml_' + key] = val;
  invalidateML();
  saveState();
  showToast(val ? `✨ ${key} adaptation on` : `🔕 ${key} adaptation paused`);
}

function showCheckin() { goTo('checkin'); }
function goToWorkout() { goTo('workout'); }

// ═══════════════════════════════════════════
// ACHIEVEMENT BADGES
// ═══════════════════════════════════════════

let _badgeQueue = [];
let _badgeShowing = false;

function evaluateBadges() {
  if (!state.badges) state.badges = [];
  Object.keys(BADGES).forEach(key => {
    if (!state.badges.includes(key) && BADGES[key].check()) {
      state.badges.push(key);
      _badgeQueue.push(key);
    }
  });
  saveState();
  if (_badgeQueue.length > 0 && !_badgeShowing) drainBadgeQueue();
}

function drainBadgeQueue() {
  if (_badgeQueue.length === 0) { _badgeShowing = false; return; }
  _badgeShowing = true;
  showBadgeReveal(_badgeQueue.shift());
}

function showBadgeReveal(key) {
  const badge = BADGES[key];
  if (!badge) { drainBadgeQueue(); return; }

  document.getElementById('br-icon').textContent = badge.icon;
  document.getElementById('br-name').textContent = badge.name;
  document.getElementById('br-desc').textContent = badge.desc;
  document.getElementById('br-ring').style.borderColor = badge.colorD;

  // Spawn CSS confetti
  const layer = document.getElementById('badge-confetti-layer');
  layer.innerHTML = '';
  const colors = [badge.color, badge.colorD, '#fff', '#F9C9A3', '#C9B8E8'];
  for (let i = 0; i < 24; i++) {
    const s = document.createElement('span');
    s.style.left              = Math.random() * 100 + '%';
    s.style.background        = colors[i % colors.length];
    s.style.animationDuration = (1.5 + Math.random() * 0.9) + 's';
    s.style.animationDelay    = (Math.random() * 0.6) + 's';
    s.style.transform         = `rotate(${Math.random() * 180}deg)`;
    layer.appendChild(s);
  }

  // Re-trigger spring animation
  const card = document.querySelector('.badge-reveal-card');
  if (card) { card.style.animation = 'none'; requestAnimationFrame(() => { card.style.animation = ''; }); }

  document.getElementById('badge-overlay').classList.add('open');
}

function closeBadgeReveal() {
  document.getElementById('badge-overlay').classList.remove('open');
  setTimeout(drainBadgeQueue, 300);
}

function getBadgeWallHTML() {
  const earned = state.badges || [];
  return Object.entries(BADGES).map(([key, badge]) => {
    const isEarned = earned.includes(key);
    const bg = isEarned ? badge.color + '33' : '#F0EAF4';
    return `<div class="badge-item">
      <div class="badge-item-icon ${isEarned ? 'earned' : 'locked'}" style="background:${bg}">${badge.icon}</div>
      <div class="badge-item-name">${badge.name}</div>
    </div>`;
  }).join('');
}

// ═══════════════════════════════════════════
// VIRTUAL PET
// ═══════════════════════════════════════════

// Returns an illustration-quality inline SVG for the given pet type and health %.
// All shapes use bezier paths for an organic, app-native look.
// Drop shadow is applied via CSS (filter: drop-shadow) on the wrapper to avoid
// SVG filter-id conflicts when multiple pets appear on the same page.
function getPetSVG(type, healthPct) {
  const expr = healthPct >= 60 ? 'happy' : healthPct >= 35 ? 'neutral' : 'sad';

  // ── CAT (Luna) — rose tones ──────────────────────────────────────────
  if (type === 'cat') {
    const body = `
      <path d="M22,30 C20,20 22,10 28,8 C30,14 28,24 24,30 Z" fill="#F2A7B4"/>
      <path d="M58,30 C60,20 58,10 52,8 C50,14 52,24 56,30 Z" fill="#F2A7B4"/>
      <path d="M23,28 C22,20 23,13 27,11 C28,15 27,23 25,28 Z" fill="#E8849A" opacity="0.55"/>
      <path d="M57,28 C58,20 57,13 53,11 C52,15 53,23 55,28 Z" fill="#E8849A" opacity="0.55"/>
      <path d="M40,14 C27,12 14,22 14,38 C14,54 24,63 40,64 C56,63 66,54 66,38 C66,22 53,12 40,14 Z" fill="#F2A7B4"/>
      <ellipse cx="23" cy="46" rx="6" ry="4" fill="#E8849A" opacity="0.28"/>
      <ellipse cx="57" cy="46" rx="6" ry="4" fill="#E8849A" opacity="0.28"/>
      <ellipse cx="40" cy="47" rx="3" ry="2" fill="#E8849A"/>
      <line x1="14" y1="44" x2="34" y2="46" stroke="#2E1F2A" stroke-width="0.8" opacity="0.18"/>
      <line x1="14" y1="49" x2="34" y2="48" stroke="#2E1F2A" stroke-width="0.8" opacity="0.18"/>
      <line x1="46" y1="46" x2="66" y2="44" stroke="#2E1F2A" stroke-width="0.8" opacity="0.18"/>
      <line x1="46" y1="48" x2="66" y2="49" stroke="#2E1F2A" stroke-width="0.8" opacity="0.18"/>`;
    const eyes = {
      happy:
        `<path d="M28,37 Q33,31 38,37" fill="none" stroke="#2E1F2A" stroke-width="2.5" stroke-linecap="round"/>
         <path d="M42,37 Q47,31 52,37" fill="none" stroke="#2E1F2A" stroke-width="2.5" stroke-linecap="round"/>`,
      neutral:
        `<circle cx="33" cy="36" r="4.5" fill="#2E1F2A"/>
         <circle cx="47" cy="36" r="4.5" fill="#2E1F2A"/>
         <circle cx="34.5" cy="34.5" r="1.5" fill="white"/>
         <circle cx="48.5" cy="34.5" r="1.5" fill="white"/>`,
      sad:
        `<circle cx="33" cy="37" r="4.5" fill="#2E1F2A"/>
         <circle cx="47" cy="37" r="4.5" fill="#2E1F2A"/>
         <circle cx="34.5" cy="35.5" r="1.5" fill="white"/>
         <circle cx="48.5" cy="35.5" r="1.5" fill="white"/>
         <path d="M26,31 Q33,29 37,33" fill="none" stroke="#2E1F2A" stroke-width="1.8" stroke-linecap="round"/>
         <path d="M43,33 Q47,29 54,31" fill="none" stroke="#2E1F2A" stroke-width="1.8" stroke-linecap="round"/>
         <ellipse cx="29" cy="46" rx="1.8" ry="2.8" fill="#C9B8E8" opacity="0.75"/>`,
    };
    const mouths = {
      happy:   `<path d="M34,52 Q40,58 46,52" fill="none" stroke="#2E1F2A" stroke-width="1.8" stroke-linecap="round"/>`,
      neutral: `<line x1="35" y1="52" x2="45" y2="52" stroke="#2E1F2A" stroke-width="1.8" stroke-linecap="round"/>`,
      sad:     `<path d="M34,54 Q40,49 46,54" fill="none" stroke="#2E1F2A" stroke-width="1.8" stroke-linecap="round"/>`,
    };
    return `<svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg">${body}${eyes[expr]}${mouths[expr]}</svg>`;
  }

  // ── BUNNY (Clover) — lilac tones ─────────────────────────────────────
  if (type === 'bunny') {
    const body = `
      <path d="M28,25 C24,12 23,4 28,2 C33,4 32,12 30,25 Z" fill="#C9B8E8"/>
      <path d="M52,25 C56,12 57,4 52,2 C47,4 48,12 50,25 Z" fill="#C9B8E8"/>
      <path d="M28,23 C25,13 24,6 28,4 C32,6 31,13 30,23 Z" fill="#A896D4" opacity="0.45"/>
      <path d="M52,23 C55,13 56,6 52,4 C48,6 49,13 50,23 Z" fill="#A896D4" opacity="0.45"/>
      <path d="M40,18 C26,16 13,26 13,42 C13,58 23,66 40,67 C57,66 67,58 67,42 C67,26 54,16 40,18 Z" fill="#C9B8E8"/>
      <ellipse cx="23" cy="50" rx="6" ry="4" fill="#A896D4" opacity="0.26"/>
      <ellipse cx="57" cy="50" rx="6" ry="4" fill="#A896D4" opacity="0.26"/>
      <ellipse cx="40" cy="52" rx="3" ry="2" fill="#A896D4"/>`;
    const eyes = {
      happy:
        `<path d="M29,41 Q34,35 39,41" fill="none" stroke="#2E1F2A" stroke-width="2.5" stroke-linecap="round"/>
         <path d="M41,41 Q46,35 51,41" fill="none" stroke="#2E1F2A" stroke-width="2.5" stroke-linecap="round"/>`,
      neutral:
        `<circle cx="34" cy="40" r="4.5" fill="#2E1F2A"/>
         <circle cx="46" cy="40" r="4.5" fill="#2E1F2A"/>
         <circle cx="35.5" cy="38.5" r="1.5" fill="white"/>
         <circle cx="47.5" cy="38.5" r="1.5" fill="white"/>`,
      sad:
        `<circle cx="34" cy="41" r="4.5" fill="#2E1F2A"/>
         <circle cx="46" cy="41" r="4.5" fill="#2E1F2A"/>
         <circle cx="35.5" cy="39.5" r="1.5" fill="white"/>
         <circle cx="47.5" cy="39.5" r="1.5" fill="white"/>
         <path d="M27,35 Q34,33 38,37" fill="none" stroke="#2E1F2A" stroke-width="1.8" stroke-linecap="round"/>
         <path d="M42,37 Q46,33 53,35" fill="none" stroke="#2E1F2A" stroke-width="1.8" stroke-linecap="round"/>
         <ellipse cx="30" cy="50" rx="1.8" ry="2.8" fill="#C9B8E8" opacity="0.7"/>`,
    };
    const mouths = {
      happy:   `<path d="M35,57 Q40,63 45,57" fill="none" stroke="#2E1F2A" stroke-width="1.8" stroke-linecap="round"/>`,
      neutral: `<line x1="36" y1="57" x2="44" y2="57" stroke="#2E1F2A" stroke-width="1.8" stroke-linecap="round"/>`,
      sad:     `<path d="M35,59 Q40,54 45,59" fill="none" stroke="#2E1F2A" stroke-width="1.8" stroke-linecap="round"/>`,
    };
    return `<svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg">${body}${eyes[expr]}${mouths[expr]}</svg>`;
  }

  // ── DOG (Poppy) — peach tones ─────────────────────────────────────────
  if (type === 'dog') {
    const body = `
      <path d="M17,34 C9,40 7,56 11,64 C16,70 23,65 25,56 C27,47 22,38 18,34 Z" fill="#F0A873"/>
      <path d="M63,34 C71,40 73,56 69,64 C64,70 57,65 55,56 C53,47 58,38 62,34 Z" fill="#F0A873"/>
      <path d="M40,14 C25,12 12,22 12,40 C12,58 22,68 40,70 C58,68 68,58 68,40 C68,22 55,12 40,14 Z" fill="#F9C9A3"/>
      <path d="M40,50 C31,48 26,54 27,60 C28,66 33,70 40,71 C47,70 52,66 53,60 C54,54 49,48 40,50 Z" fill="#F0A873" opacity="0.5"/>
      <ellipse cx="21" cy="46" rx="6.5" ry="4.5" fill="#F0A873" opacity="0.38"/>
      <ellipse cx="59" cy="46" rx="6.5" ry="4.5" fill="#F0A873" opacity="0.38"/>
      <ellipse cx="40" cy="52" rx="5.5" ry="4" fill="#2E1F2A"/>
      <ellipse cx="38.5" cy="50.5" rx="1.5" ry="1" fill="white" opacity="0.6"/>`;
    const eyes = {
      happy:
        `<path d="M26,36 Q32,30 38,36" fill="none" stroke="#2E1F2A" stroke-width="2.5" stroke-linecap="round"/>
         <path d="M42,36 Q48,30 54,36" fill="none" stroke="#2E1F2A" stroke-width="2.5" stroke-linecap="round"/>`,
      neutral:
        `<circle cx="32" cy="35" r="5" fill="#2E1F2A"/>
         <circle cx="48" cy="35" r="5" fill="#2E1F2A"/>
         <circle cx="33.5" cy="33.5" r="1.8" fill="white"/>
         <circle cx="49.5" cy="33.5" r="1.8" fill="white"/>`,
      sad:
        `<circle cx="32" cy="36" r="5" fill="#2E1F2A"/>
         <circle cx="48" cy="36" r="5" fill="#2E1F2A"/>
         <circle cx="33.5" cy="34.5" r="1.8" fill="white"/>
         <circle cx="49.5" cy="34.5" r="1.8" fill="white"/>
         <path d="M24,29 Q32,27 37,32" fill="none" stroke="#2E1F2A" stroke-width="2" stroke-linecap="round"/>
         <path d="M43,32 Q48,27 56,29" fill="none" stroke="#2E1F2A" stroke-width="2" stroke-linecap="round"/>
         <ellipse cx="27" cy="47" rx="1.8" ry="2.8" fill="#C9B8E8" opacity="0.7"/>`,
    };
    const mouths = {
      happy:
        `<path d="M32,59 Q40,66 48,59" fill="none" stroke="#2E1F2A" stroke-width="1.8" stroke-linecap="round"/>
         <ellipse cx="40" cy="64" rx="5" ry="4" fill="#E8849A"/>`,
      neutral: `<line x1="34" y1="59" x2="46" y2="59" stroke="#2E1F2A" stroke-width="1.8" stroke-linecap="round"/>`,
      sad:     `<path d="M32,61 Q40,55 48,61" fill="none" stroke="#2E1F2A" stroke-width="1.8" stroke-linecap="round"/>`,
    };
    return `<svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg">${body}${eyes[expr]}${mouths[expr]}</svg>`;
  }

  // ── FLOWER (Bloom) — rose tones, matches app icon ──────────────────────
  const petalBase = `M40,40 C37,30 37,16 40,12 C43,16 43,30 40,40 Z`;
  const petalSm   = `M40,40 C38.5,33 38.5,21 40,18 C41.5,21 41.5,33 40,40 Z`;
  const petals  = [0,72,144,216,288].map(r =>
    `<g transform="rotate(${r} 40 40)"><path d="${petalBase}" fill="#F2A7B4"/></g>`).join('');
  const petals2 = [36,108,180,252,324].map(r =>
    `<g transform="rotate(${r} 40 40)"><path d="${petalSm}" fill="#E8849A" opacity="0.42"/></g>`).join('');
  const flowerBody = `
    ${petals}${petals2}
    <circle cx="40" cy="40" r="19" fill="#F9C9A3"/>
    <circle cx="40" cy="40" r="19" fill="none" stroke="#E8849A" stroke-width="1" opacity="0.32"/>
    <circle cx="40" cy="44" r="1.8" fill="#E8849A"/>`;
  const flowerEyes = {
    happy:
      `<path d="M32,38 Q36,33 40,38" fill="none" stroke="#2E1F2A" stroke-width="2" stroke-linecap="round"/>
       <path d="M40,38 Q44,33 48,38" fill="none" stroke="#2E1F2A" stroke-width="2" stroke-linecap="round"/>`,
    neutral:
      `<circle cx="35" cy="37" r="3.5" fill="#2E1F2A"/>
       <circle cx="45" cy="37" r="3.5" fill="#2E1F2A"/>
       <circle cx="36" cy="35.5" r="1" fill="white"/>
       <circle cx="46" cy="35.5" r="1" fill="white"/>`,
    sad:
      `<circle cx="35" cy="38" r="3.5" fill="#2E1F2A"/>
       <circle cx="45" cy="38" r="3.5" fill="#2E1F2A"/>
       <circle cx="36" cy="36.5" r="1" fill="white"/>
       <circle cx="46" cy="36.5" r="1" fill="white"/>
       <path d="M30,33 Q35,31 38,35" fill="none" stroke="#2E1F2A" stroke-width="1.5" stroke-linecap="round"/>
       <path d="M42,35 Q45,31 50,33" fill="none" stroke="#2E1F2A" stroke-width="1.5" stroke-linecap="round"/>`,
  };
  const flowerMouths = {
    happy:   `<path d="M35,48 Q40,53 45,48" fill="none" stroke="#2E1F2A" stroke-width="1.5" stroke-linecap="round"/>`,
    neutral: `<line x1="36" y1="48" x2="44" y2="48" stroke="#2E1F2A" stroke-width="1.5" stroke-linecap="round"/>`,
    sad:     `<path d="M35,50 Q40,45 45,50" fill="none" stroke="#2E1F2A" stroke-width="1.5" stroke-linecap="round"/>`,
  };
  return `<svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg">${flowerBody}${flowerEyes[expr]}${flowerMouths[expr]}</svg>`;
}

function getPetData() {
  if (!state.pet || !state.pet.type) return null;
  const def = PET_TYPES[state.pet.type] || PET_TYPES.cat;
  const health = state.pet.health ?? 100;
  let mood, emoji, hint, barColor;
  if (health >= 80) {
    mood = 'Thriving ✨'; emoji = def.happy;
    hint = 'Keep it up — ' + def.name + ' loves your dedication!';
    barColor = 'var(--sage-d)';
  } else if (health >= 60) {
    mood = 'Happy 🌸'; emoji = def.emoji;
    hint = 'Check in or work out to keep ' + def.name + ' happy!';
    barColor = 'var(--sage)';
  } else if (health >= 35) {
    mood = 'Getting hungry 🍽️'; emoji = def.hungry;
    hint = def.name + ' needs a workout or check-in today!';
    barColor = 'var(--peach)';
  } else {
    mood = 'Really sad 😢'; emoji = def.sad;
    hint = def.name + ' really misses you — come back and work out! 💕';
    barColor = 'var(--rose-d)';
  }
  return { def, health, mood, emoji, hint, barColor };
}

function feedPet(amount) {
  if (!state.pet || !state.pet.type) return;
  const today = new Date().toISOString().split('T')[0];
  state.pet.health = Math.min(100, (state.pet.health ?? 50) + amount);
  state.pet.lastFedDate = today;
  state.pet.totalFeeds = (state.pet.totalFeeds || 0) + 1;
}

function decayPetHealth() {
  if (!state.pet || !state.pet.type) return;
  const today = new Date().toISOString().split('T')[0];
  const lastFed = state.pet.lastFedDate;
  if (!lastFed) { state.pet.lastFedDate = today; return; }
  const days = Math.floor((new Date(today) - new Date(lastFed)) / MS_PER_DAY);
  if (days > 0) {
    // 20 health lost per missed day, min 5 so pet never fully disappears
    state.pet.health = Math.max(5, (state.pet.health ?? 100) - days * 20);
  }
}

function renderPetCard() {
  const card = document.getElementById('pet-card');
  if (!card) return;
  card.style.display = 'block';

  const pd = getPetData();

  // No pet yet — show inline SVG picker so existing users can adopt one
  if (!pd) {
    card.innerHTML = `
      <div class="pet-card-label">YOUR COMPANION</div>
      <div style="font-size:13px;color:var(--ink);font-weight:600;margin-bottom:4px">Pick a companion</div>
      <div style="font-size:11px;color:var(--mid);margin-bottom:14px">They thrive on your workouts & check-ins!</div>
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px">
        ${Object.entries(PET_TYPES).map(([key, p]) => `
          <button onclick="adoptPet('${key}')" style="background:#F7F2FA;border:1.5px solid rgba(202,168,186,0.3);border-radius:14px;padding:10px 4px;cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:4px;font-family:'Nunito',sans-serif;transition:all .2s">
            <div style="width:52px;height:52px;filter:drop-shadow(0 1px 2px rgba(46,31,42,0.12))">${getPetSVG(key, 100)}</div>
            <span style="font-size:10px;font-weight:700;color:var(--ink)">${p.name}</span>
          </button>`).join('')}
      </div>`;
    return;
  }

  // Restore standard card markup if coming from picker state
  if (!document.getElementById('pet-avatar')) {
    card.innerHTML = `
      <div class="pet-card-label">YOUR COMPANION</div>
      <div class="pet-body">
        <div class="pet-avatar" id="pet-avatar"></div>
        <div class="pet-info">
          <div class="pet-name-row">
            <span class="pet-name" id="pet-name"></span>
            <span class="pet-mood-label" id="pet-mood-label"></span>
          </div>
          <div class="pet-bar-wrap">
            <div class="pet-health-fill" id="pet-health-fill" style="width:100%;background:var(--sage-d)"></div>
          </div>
          <div class="pet-hint" id="pet-hint"></div>
        </div>
      </div>`;
  }

  document.getElementById('pet-avatar').innerHTML     = getPetSVG(state.pet.type, pd.health);
  document.getElementById('pet-name').textContent     = pd.def.name;
  document.getElementById('pet-mood-label').textContent = pd.mood;
  document.getElementById('pet-hint').textContent     = pd.hint;

  const fill = document.getElementById('pet-health-fill');
  fill.style.width      = pd.health + '%';
  fill.style.background = pd.barColor;

  const avatar = document.getElementById('pet-avatar');
  if (pd.health >= 80) {
    avatar.style.animation = 'petBounce 2s ease-in-out infinite';
  } else if (pd.health < 35) {
    avatar.style.animation = 'petShiver 0.4s ease-in-out infinite';
  } else {
    avatar.style.animation = 'none';
  }
}

function adoptPet(type) {
  state.pet = {
    type,
    health: 100,
    lastFedDate: new Date().toISOString().split('T')[0],
    totalFeeds: 0,
  };
  saveState();
  renderPetCard();
  const name = (PET_TYPES[type] || PET_TYPES.cat).name;
  showToast(`🐾 ${name} is now your companion!`);
}

let _selectedPet = null;
function selectPet(el, type) {
  document.querySelectorAll('.pet-pick-btn').forEach(b => b.classList.remove('selected'));
  el.classList.add('selected');
  _selectedPet = type;
  const btn = document.getElementById('ob-pet-btn');
  if (btn) { btn.disabled = false; btn.style.opacity = '1'; }
}

// ═══════════════════════════════════════════
// PHASE ENERGY CARD
// ═══════════════════════════════════════════

function renderPhaseEnergyCard() {
  const card = document.getElementById('phase-energy-card');
  if (!card) return;
  const phase  = PHASES[state.phase] || PHASES.follicular;
  const ml     = getMLResult();
  const score  = ml.readiness.score;
  const cycDay = state.cycleDay || getCycleDay();
  const cycLen = state.cycle.cycleLength || 28;

  card.style.background = phase.bg;
  card.style.color      = phase.textColor;

  document.getElementById('pec-score').textContent      = score;
  document.getElementById('pec-score').style.color      = phase.colorD;
  document.getElementById('pec-phase-chip').textContent = phase.icon + ' ' + phase.name;
  document.getElementById('pec-phase-chip').style.background = phase.color + '44';

  const f = ml.features;
  const descMap = {
    PR_WINDOW:            'Peak window — go heavy today ⚡️',
    PROGRESSIVE_OVERLOAD: 'Strength is building 💜',
    MAINTAIN:             'Solid foundation day 🌸',
    SLIGHT_REDUCE:        f.energy >= 7 ? 'Phase-aware volume today 🌿' : 'Listen and recover 🍃',
    DELOAD_ACWR:          'Protect the gains 🌿',
    SKIP_PATTERN:         'Show up, even gently 💕',
    SAFETY_OVERRIDE:      'Rest is training today 🩸',
    RECOVERY:             f.energy >= 7 ? 'Phase recovery mode 🍃' : 'Recovery mode — move gently 🍃',
  };
  document.getElementById('pec-desc').textContent =
    descMap[ml.modifier.action] || phase.chips[0] || '';

  // Whole card is tappable for all phases — opens phase picker sheet
  card.style.cursor = 'pointer';
  card.onclick = showPhaseCorrectionSheet;
  // Remove old chip-level hint if it was added in a previous render
  const phaseChip = document.getElementById('pec-phase-chip');
  phaseChip.style.cursor = '';
  phaseChip.removeAttribute('title');
  phaseChip.onclick = null;
  const oldHint = phaseChip.querySelector('.pec-chip-hint');
  if (oldHint) oldHint.remove();

  // SVG orb — size and glow tied to readiness score
  const orbR  = 8 + score * 0.13;     // 8 (score 0) → ~21 (score 100)
  const glowR = orbR + 5;
  const midOp = (score / 100 * 0.55 + 0.2).toFixed(2);
  const dotAngle = (cycDay / cycLen) * 2 * Math.PI - Math.PI / 2;
  const dotX  = (50 + 36 * Math.cos(dotAngle)).toFixed(1);
  const dotY  = (50 + 36 * Math.sin(dotAngle)).toFixed(1);
  const fId   = 'orb-blur-' + state.phase;

  document.getElementById('pec-orb-wrap').innerHTML = `
    <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <filter id="${fId}" x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="2.5"/>
        </filter>
      </defs>
      <circle class="orbit-ring" cx="50" cy="50" r="36"
        stroke="${phase.color}" stroke-width="1.5" fill="none" opacity="0.45"
        style="animation:orbitRing 10s linear infinite"/>
      <circle class="orbit-ring" cx="50" cy="50" r="26"
        stroke="${phase.colorD}" stroke-width="1.5" fill="none" opacity="${midOp}"
        style="animation:orbitRing 6s linear infinite reverse"/>
      <circle cx="50" cy="50" r="${glowR}"
        fill="${phase.color}" opacity="0.28" filter="url(#${fId})"/>
      <circle cx="50" cy="50" r="${orbR.toFixed(1)}"
        fill="${phase.colorD}" opacity="0.9"/>
      <circle cx="${dotX}" cy="${dotY}" r="3.5"
        fill="${phase.colorD}" opacity="0.95"/>
    </svg>`;
}

// ── Phase correction — user can set their phase from the energy card ──
function showPhaseCorrectionSheet() {
  const sheet = document.getElementById('phase-correction-sheet');
  if (sheet) sheet.classList.add('open');
}
function closePhaseCorrectionSheet() {
  const sheet = document.getElementById('phase-correction-sheet');
  if (sheet) sheet.classList.remove('open');
}

// Set lastPeriodStart so today falls at the midpoint of the chosen phase
function correctToPhase(phase) {
  const pl = state.cycle.phaseLengths;
  const phaseStarts = {
    menstrual:  1,
    follicular: pl.menstrual + 1,
    ovulatory:  pl.menstrual + pl.follicular + 1,
    luteal:     pl.menstrual + pl.follicular + pl.ovulatory + 1,
  };
  const phaseLens = { menstrual: pl.menstrual, follicular: pl.follicular,
                      ovulatory: pl.ovulatory, luteal: pl.luteal };
  const targetCycleDay = phaseStarts[phase] + Math.floor(phaseLens[phase] / 2);
  const d = new Date();
  d.setDate(d.getDate() - (targetCycleDay - 1));
  state.cycle.lastPeriodStart = d.toISOString().split('T')[0];
  advanceCycleDay(); invalidateML(); saveState();
  closePhaseCorrectionSheet(); renderToday();
  const label = { menstrual:'menstrual', follicular:'follicular', ovulatory:'ovulatory', luteal:'luteal' }[phase];
  showToast(`✨ Phase updated to ${label}`);
}

// Called when user confirms period just started from the energy card
function confirmPeriodStarted() {
  recordPeriodStart();   // sets cycleDay=1, phase='menstrual', saves state
  closePhaseCorrectionSheet();
  renderToday();
  showToast('🌸 Period logged — Bloom will learn from this');
}

// ═══════════════════════════════════════════
// WEEK PLANNER
// ═══════════════════════════════════════════

function getWeekMonday() {
  const d = new Date();
  const diff = (d.getDay() + 6) % 7; // days since Monday
  d.setDate(d.getDate() - diff);
  return d.toISOString().split('T')[0];
}

function buildDefaultSchedule(phase, n) {
  // Reduce training days in menstrual phase to protect recovery
  const effectiveDays = (phase === 'menstrual') ? Math.max(1, n - 1) : n;
  const clamped = Math.min(5, Math.max(1, effectiveDays));
  const patterns = {
    1: [2],             // Wed
    2: [1, 4],          // Tue, Fri
    3: [0, 2, 4],       // Mon, Wed, Fri
    4: [0, 1, 3, 4],    // Mon, Tue, Thu, Fri
    5: [0, 1, 2, 3, 4], // Mon–Fri
  };
  const trainSet = new Set(patterns[clamped]);
  return Array.from({ length: 7 }, (_, i) => trainSet.has(i));
}

function getWeekSchedule() {
  const thisMonday = getWeekMonday();
  if (state.weekScheduleWeek !== thisMonday || !state.weekSchedule) {
    state.weekScheduleWeek = thisMonday;
    state.weekSchedule = buildDefaultSchedule(
      state.phase || 'follicular',
      state.trainingDaysPerWeek || 3
    );
    saveState();
  }
  return state.weekSchedule;
}

function toggleWeekDay(dayIdx) {
  const schedule = getWeekSchedule();
  // Don't allow toggling already-completed days
  const mondayDate = new Date(getWeekMonday());
  mondayDate.setDate(mondayDate.getDate() + dayIdx);
  const dateStr = mondayDate.toISOString().split('T')[0];
  if ((state.weekCompletions || {})[dateStr]) return;

  schedule[dayIdx] = !schedule[dayIdx];
  state.weekSchedule = [...schedule];
  saveState();
  renderWeekStrip();

  const trainingCount = schedule.filter(Boolean).length;
  const msg = schedule[dayIdx]
    ? `Training day added · ${trainingCount} days this week 💪`
    : `Rest day set · ${trainingCount} training days this week 🍃`;
  showToast(msg);
}

function resetWeekSchedule() {
  state.weekScheduleWeek = getWeekMonday();
  state.weekSchedule = buildDefaultSchedule(
    state.phase || 'follicular',
    state.trainingDaysPerWeek || 3
  );
  saveState();
  renderWeekStrip();
  showToast('✨ Week rebuilt by Bloom!');
}

function renderWeekStrip() {
  const strip = document.getElementById('week-strip');
  if (!strip) return;

  const schedule = getWeekSchedule();
  const todayIdx = (new Date().getDay() + 6) % 7;
  const mondayDate = new Date(getWeekMonday());
  const completions = state.weekCompletions || {};
  const currentCycleDay = state.cycleDay || getCycleDay();
  const cycleLen = state.cycle.cycleLength || 28;

  const phaseColors = { menstrual:'#F2A7B4', follicular:'#C9B8E8', ovulatory:'#F9C9A3', luteal:'#B8D4C0' };
  const phaseIcons  = { menstrual:'🌹', follicular:'🌷', ovulatory:'⚡️', luteal:'🍂' };
  const phaseTypes  = { menstrual:'Gentle', follicular:'Build', ovulatory:'Peak', luteal:'Steady' };
  const dayNames    = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];

  strip.innerHTML = dayNames.map((d, i) => {
    const dayDate = new Date(mondayDate);
    dayDate.setDate(mondayDate.getDate() + i);
    const dateStr = dayDate.toISOString().split('T')[0];

    const isToday     = i === todayIdx;
    const isPast      = i < todayIdx;
    const isCompleted = !!(completions[dateStr]);
    const isTraining  = schedule[i];
    const isMissed    = isPast && isTraining && !isCompleted;

    // Approximate cycle phase for this day
    const offsetDay = currentCycleDay + (i - todayIdx);
    const wrappedDay = ((offsetDay - 1 + cycleLen * 10) % cycleLen) + 1;
    const dayPhase = getPhaseFromDay(wrappedDay) || state.phase || 'follicular';

    let classes = 'ws-day';
    if (isToday)      classes += ' today';
    if (isCompleted)  classes += ' ws-done';
    else if (isTraining) classes += ' ws-training';
    else              classes += ' ws-rest';
    if (isMissed)     classes += ' ws-missed';

    let icon, typeLabel, inlineStyle = '';
    if (isCompleted) {
      icon = '✓'; typeLabel = 'Done!';
    } else if (!isTraining) {
      icon = '💤'; typeLabel = 'Rest';
    } else {
      icon = phaseIcons[dayPhase] || '🌸';
      typeLabel = phaseTypes[dayPhase] || 'Train';
      if (!isPast) {
        inlineStyle = ` style="border-color:${phaseColors[dayPhase]}80;background:${phaseColors[dayPhase]}20"`;
      }
    }

    return `<div class="${classes}" onclick="toggleWeekDay(${i})"${inlineStyle}><div class="ws-d-label">${d}</div><span class="ws-d-icon">${icon}</span><div class="ws-d-type">${typeLabel}</div></div>`;
  }).join('');
}

// ═══════════════════════════════════════════
// TODAY SCREEN
// ═══════════════════════════════════════════
function renderToday() {
  const ml = getMLResult();
  const { features: f, readiness, modifier, explanation } = ml;
  const phase = PHASES[state.phase];
  const workout = getWorkout();
  const hour = new Date().getHours();
  const greetEmoji = hour < 12 ? '☀️' : hour < 18 ? '🌸' : '🌙';
  const greetWord = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';

  document.getElementById('today-greeting').textContent = `Good ${greetWord}, ${state.name} ${greetEmoji}`;
  document.getElementById('today-title').innerHTML = `Day ${state.cycleDay} · <span style="font-family:'Playfair Display',serif;font-style:italic;color:${phase.colorD}">${phase.name} phase</span>`;

  // cycle arc
  ['arc-1','arc-2','arc-3','arc-4'].forEach((id,i) => {
    document.getElementById(id).classList.toggle('active', i === phase.arcIdx);
  });
  ['arc-l1','arc-l2','arc-l3','arc-l4'].forEach((id,i) => {
    document.getElementById(id).classList.toggle('active', i === phase.arcIdx);
  });
  // today-hero-bg removed for premium layout

  // hormone snapshot bars
  setTimeout(() => {
    document.getElementById('hs-estrogen').style.width = Math.round(f.estrogen * 100) + '%';
    document.getElementById('hs-prog').style.width = Math.round(f.progesterone * 100) + '%';
    document.getElementById('hs-ready').style.width = readiness.score + '%';
    const eLabels = ['Very Low','Low','Rising','High','Peak'];
    document.getElementById('hs-e-val').textContent = eLabels[Math.round(f.estrogen * 4)] || '—';
    const pLabels = ['Low','Low','Moderate','High','Peak'];
    document.getElementById('hs-p-val').textContent = pLabels[Math.round(f.progesterone * 4)] || '—';
    document.getElementById('hs-r-val').textContent = readiness.score + '/100';
    const rBar = document.getElementById('hs-ready');
    rBar.style.background = readiness.score >= 75 ? 'var(--sage)' : readiness.score >= 45 ? 'var(--peach)' : 'var(--rose)';
  }, 120);

  // phase banner
  document.getElementById('phase-banner').style.background = phase.bg;
  document.getElementById('phase-banner').style.color = phase.textColor;
  document.getElementById('phase-glow').style.background = phase.color;
  document.getElementById('phase-label-sm').textContent = `${phase.icon} Phase · Days ${phase.day}`;
  document.getElementById('phase-name-big').textContent = phase.name;
  document.getElementById('phase-desc').textContent = phase.desc;
  document.getElementById('phase-chips').innerHTML = phase.chips.map(c => `<span class="phase-chip">${c}</span>`).join('');

  // Phase energy card
  renderPhaseEnergyCard();

  // Pet companion card
  renderPetCard();

  // week strip
  renderWeekStrip();

  // workout card
  document.getElementById('wc-header').style.background = workout.color;
  document.getElementById('wc-bg-emoji').textContent = workout.emoji;
  document.getElementById('wc-type').textContent = workout.type;
  document.getElementById('wc-name').textContent = workout.name;
  document.getElementById('wc-reason').textContent = workout.reason;
  document.getElementById('wc-duration').textContent = workout.duration;
  document.getElementById('wc-intensity').textContent = workout.intensity;
  document.getElementById('wc-kcal').textContent = workout.kcal;

  // insight
  document.getElementById('insight-text').textContent = phase.insight;

  // Cycle model confidence card
  const conf = state.cycle.confidence;
  const confPct = Math.round(conf * 100);
  const cycDay = state.cycleDay || getCycleDay();
  const daysToNext = (() => {
    const pl = state.cycle.phaseLengths;
    const boundaries = [pl.menstrual, pl.menstrual+pl.follicular, pl.menstrual+pl.follicular+pl.ovulatory, state.cycle.cycleLength];
    const next = boundaries.find(b => b > cycDay) || state.cycle.cycleLength;
    return next - cycDay;
  })();

  const confIcon = conf >= 0.8 ? '🌙' : conf >= 0.6 ? '🌗' : conf >= 0.4 ? '🌓' : '🌑';
  const confLabel = conf >= 0.8 ? 'Cycle model accurate' : conf >= 0.6 ? 'Cycle model learning' : conf >= 0.4 ? 'Cycle model building' : 'Cycle model starting';
  const confSub = state.cycle.healthKitLinked
    ? `Apple Health linked · ${state.cycle.periodHistory.length} cycles learned`
    : conf < 0.6
    ? `Tap "Period started" in check-in to improve accuracy`
    : `${state.cycle.periodHistory.length} period${state.cycle.periodHistory.length !== 1 ? 's' : ''} tracked · ~${daysToNext}d to next phase`;

  document.getElementById('cmc-icon').textContent = confIcon;
  document.getElementById('cmc-title').textContent = confLabel;
  document.getElementById('cmc-sub').textContent   = confSub;
  document.getElementById('cmc-conf-pct').textContent = confPct + '%';
  document.getElementById('cmc-conf-pct').style.color = conf >= 0.7 ? 'var(--sage-d)' : conf >= 0.5 ? 'var(--peach)' : 'var(--rose-d)';
  setTimeout(() => {
    const bar = document.getElementById('cmc-conf-bar');
    if (bar) bar.style.width = confPct + '%';
  }, 150);

  // ML teaser
  const score = readiness.score;
  const scoreLabel = score >= 75 ? '🟢 High readiness' : score >= 45 ? '🟡 Moderate readiness' : '🔴 Low readiness';
  document.getElementById('ml-teaser-text').textContent = explanation.length > 110 ? explanation.slice(0,108)+'…' : explanation;
  const teaserChips = document.getElementById('ml-teaser-chips');
  teaserChips.innerHTML = [
    `<span style="font-size:10px;padding:3px 9px;border-radius:100px;background:rgba(255,255,255,.1);color:rgba(255,255,255,.7)">${scoreLabel}</span>`,
    `<span style="font-size:10px;padding:3px 9px;border-radius:100px;background:rgba(255,255,255,.1);color:rgba(255,255,255,.7)">Score: ${score}/100</span>`,
    `<span style="font-size:10px;padding:3px 9px;border-radius:100px;background:rgba(255,255,255,.1);color:rgba(255,255,255,.7)">Vol: ${modifier.volumeMod >= 0 ? '+' : ''}${modifier.volumeMod}%</span>`,
  ].join('');
}

// ─────────────────────────────────────────
// ML SCREEN RENDERER
// ─────────────────────────────────────────
function renderML() {
  const ml = getMLResult();
  const { features: f, readiness, modifier, explanation } = ml;

  // Readiness score
  const score = readiness.score;
  const scoreEl = document.getElementById('ml-readiness-score');
  const barEl   = document.getElementById('ml-readiness-bar');
  scoreEl.textContent = score;
  const scoreColor = score >= 75 ? 'var(--sage)' : score >= 45 ? 'var(--peach)' : 'var(--rose)';
  scoreEl.style.color = scoreColor;
  setTimeout(() => { barEl.style.width = score + '%'; barEl.style.background = scoreColor; }, 100);

  const verdicts = [
    [75, 'High Readiness 🟢',    'Your body is primed. Push with confidence today.'],
    [45, 'Moderate Readiness 🟡','You can train well. Keep intensity measured.'],
    [0,  'Low Readiness 🔴',     'Your body is asking for support. Gentle is smart.'],
  ];
  const [,vLabel, vDesc] = verdicts.find(([min]) => score >= min) || verdicts[2];
  document.getElementById('ml-verdict').textContent = vLabel;
  document.getElementById('ml-verdict-desc').textContent = vDesc;

  // Decision text
  document.getElementById('ml-decision-text').textContent = explanation;

  // SHAP bars
  const shapCard = document.getElementById('ml-shap-card');
  shapCard.innerHTML = '';
  const maxVal = Math.max(...readiness.contributions.map(c => c.value), 0.01);
  readiness.contributions.slice(0,5).forEach(c => {
    const pct = Math.round((c.value / maxVal) * 100);
    shapCard.innerHTML += `
      <div class="shap-row">
        <span class="shap-feature">${c.name}</span>
        <div class="shap-bar-bg"><div class="shap-fill" style="width:0%;background:${c.color}" data-w="${pct}%"></div></div>
        <span class="shap-weight">${(c.value * 100).toFixed(0)}</span>
      </div>`;
  });
  setTimeout(() => {
    shapCard.querySelectorAll('.shap-fill').forEach(el => {
      el.style.transition = 'width .7s cubic-bezier(.4,0,.2,1)';
      el.style.width = el.getAttribute('data-w');
    });
  }, 120);

  // Step-by-step decision chain
  const phaseNames = { menstrual:'Menstrual 🌹', follicular:'Follicular 🌷', ovulatory:'Ovulatory ⚡️', luteal:'Luteal 🍂' };
  const dotColors = { menstrual:'#F2A7B4', follicular:'#C9B8E8', ovulatory:'#F9C9A3', luteal:'#B8D4C0' };
  const steps = [
    {
      dot: dotColors[f.phase] || 'var(--rose)',
      title: '1. Phase context loaded',
      desc: `You're in ${phaseNames[f.phase]}, Day ${state.cycleDay}. Estrogen is ${f.estrogen >= 0.7 ? 'high' : f.estrogen >= 0.4 ? 'moderate' : 'low'}, progesterone is ${f.progesterone >= 0.6 ? 'elevated' : 'low'}.`,
      output: `→ Hormone multiplier: ${f.estrogen >= 0.7 ? '+strength window' : f.progesterone >= 0.6 ? '+recovery priority' : 'neutral'}`
    },
    {
      dot: 'var(--peach)',
      title: '2. Check-in signals read',
      desc: `Energy: ${f.energy}/10 (${f.energyDelta >= 0 ? '+' : ''}${f.energyDelta.toFixed(1)} vs your baseline). Mood: ${f.mood}/5. Symptoms logged: ${state.symptoms.length > 0 ? state.symptoms.join(', ') : 'none'}.`,
      output: `→ Psycho-physiological score: ${Math.round((f.energy/10 + f.mood/5) / 2 * 100)}%`
    },
    {
      dot: 'var(--lilac)',
      title: '3. Training load calculated',
      desc: `ACWR: ${f.acwr.toFixed(2)} (${f.acwr > 1.3 ? '⚠ high — risk of overreaching' : f.acwr < 0.7 ? 'very fresh — low base' : '✓ optimal range'}). Fatigue index: ${Math.round(f.fatigueAccum * 100)}%.`,
      output: `→ Load flag: ${f.acwr > 1.5 ? 'DELOAD TRIGGERED' : f.acwr > 1.3 ? 'moderate caution' : 'clear to train'}`
    },
    {
      dot: 'var(--sage)',
      title: '4. Readiness score computed',
      desc: `All signals weighted and combined. Top driver was "${readiness.contributions[0]?.name || 'energy today'}" (${(readiness.contributions[0]?.value * 100 || 0).toFixed(0)} pts).`,
      output: `→ Readiness: ${score}/100 · Confidence: ${Math.round((readiness.confidence || 0.85) * 100)}%`
    },
    {
      dot: f.hasCramps ? 'var(--rose)' : 'var(--peach)',
      title: f.hasCramps ? '5. Safety rule applied' : '5. Bandit policy selected',
      desc: f.hasCramps
        ? 'Cramps logged — safety override activated. Bandit bypassed. Hard cap: low intensity only.'
        : `Score ${score} + phase "${f.phase}" → policy action "${modifier.action}". Volume modifier: ${modifier.volumeMod >= 0 ? '+' : ''}${modifier.volumeMod}%.`,
      output: `→ Intensity: ${modifier.intensityLabel} · Session: ${getWorkout().name}`
    },
  ];
  const stepsEl = document.getElementById('ml-why-steps');
  stepsEl.innerHTML = steps.map(s => `
    <div class="ml-why-step">
      <div class="ml-step-line">
        <div class="ml-step-dot" style="background:${s.dot}"></div>
        <div class="ml-step-connector"></div>
      </div>
      <div class="ml-step-content">
        <div class="ml-step-title">${s.title}</div>
        <div class="ml-step-desc">${s.desc}</div>
        <div class="ml-step-output" style="color:${s.dot}">${s.output}</div>
      </div>
    </div>`).join('');

  // Signal grid
  document.getElementById('sig-phase').textContent    = phaseNames[f.phase] || f.phase;
  document.getElementById('sig-phase-sub').textContent = `Day ${state.cycleDay} of cycle`;
  document.getElementById('sig-energy').textContent   = `${f.energy}/10`;
  document.getElementById('sig-energy-sub').textContent = (f.energyDelta >= 0 ? '+' : '') + f.energyDelta.toFixed(1) + ' vs baseline';
  document.getElementById('sig-mood').textContent     = `${f.mood}/5`;
  const moodLabels = ['','😔 Low','😐 Neutral','🙂 Okay','😄 Good','🌟 Great'];
  document.getElementById('sig-mood-sub').textContent = moodLabels[f.mood] || '';
  document.getElementById('sig-acwr').textContent     = f.acwr.toFixed(2);
  document.getElementById('sig-acwr-sub').textContent = f.acwr > 1.3 ? '⚠ High load' : f.acwr < 0.7 ? 'Fresh' : '✓ Optimal';
  document.getElementById('sig-fatigue').textContent  = Math.round(f.fatigueAccum * 100) + '%';
  document.getElementById('sig-fatigue-sub').textContent = f.fatigueAccum > 0.65 ? 'Elevated' : f.fatigueAccum > 0.35 ? 'Moderate' : 'Low';
  document.getElementById('sig-skip').textContent     = Math.round(f.skipRate * 100) + '%';
  document.getElementById('sig-skip-sub').textContent = f.skipRate > 0.4 ? 'Pattern detected' : 'Consistent';

  // Pipeline outputs
  const w = getWorkout();
  document.getElementById('pipe-m1').textContent = `${score}/100`;
  document.getElementById('pipe-m2').textContent = w.type;
  document.getElementById('pipe-m3').textContent = `Vol ${modifier.volumeMod >= 0?'+':''}${modifier.volumeMod}% · ${modifier.intensityLabel}`;
  document.getElementById('pipe-m4').textContent = `${(w.exercises||[]).length} exercises`;
}

function makeEasier() {
  state.energy = Math.max(1, state.energy - 2);
  invalidateML();
  renderToday();
  showToast('💕 Plan adjusted to be gentler');
}

function skipToday() {
  state.listenedToBody++;
  saveState();
  showToast('🍃 Rest logged. That\'s training too.');
}

// ═══════════════════════════════════════════
// CHECK-IN
// ═══════════════════════════════════════════
function setMood(val, el) {
  state.mood = val;
  document.querySelectorAll('.mood-btn').forEach(b => b.classList.remove('selected'));
  el.classList.add('selected');
}

function setEnergy(e) {
  const track = document.getElementById('energy-track');
  const rect = track.getBoundingClientRect();
  const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  const val = Math.round(pct * 10);
  state.energy = val;
  document.getElementById('energy-fill').style.width = (pct * 100) + '%';
  document.getElementById('energy-thumb').style.left = (pct * 100) + '%';
  document.getElementById('energy-value').textContent = `${val} / 10`;
}

function toggleSymptom(el, sym) {
  el.classList.toggle('selected');
  if (state.symptoms.includes(sym)) state.symptoms = state.symptoms.filter(s => s !== sym);
  else state.symptoms.push(sym);
}

// Called when "My period started today" is tapped
function onPeriodStarted() {
  const btn = document.getElementById('period-started-btn');
  btn.classList.add('confirmed');
  btn.querySelector('.psb-icon').textContent = '✅';
  btn.querySelector('.psb-title').textContent = 'Period logged 💕';
  btn.querySelector('.psb-sub').textContent = 'Bloom will update your cycle model';
  // Mark for processing on submit
  state._periodStartedToday = true;
  // Pre-select cramps chip as likely
  const crampsChip = document.querySelector('[onclick*="cramps"]');
  if (crampsChip && !state.symptoms.includes('cramps')) {
    crampsChip.classList.add('selected');
    state.symptoms.push('cramps');
  }
}

// Apple Health / Health Connect
async function connectHealthKit() {
  const btn = document.querySelector('.health-connect-btn');
  if (btn) { btn.textContent = 'Connecting...'; }
  const linked = await tryHealthKitSync();
  if (linked) {
    showToast('🍎 Apple Health linked — cycle data synced!');
    document.getElementById('health-connect-section').style.display = 'none';
    advanceCycleDay();
    renderToday();
  } else {
    showToast('Health data not available — using check-ins instead 💕');
    if (btn) {
      btn.innerHTML = `<span style="font-size:18px">🍎</span><div style="flex:1;text-align:left"><div style="font-size:13px;font-weight:700;color:var(--mid)">Not available</div><div style="font-size:11px;color:var(--light)">Using symptom inference instead</div></div>`;
    }
  }
}

function submitCheckin() {
  // If period started, run the learning update first
  if (state._periodStartedToday) {
    recordPeriodStart();
    state._periodStartedToday = false;
  } else {
    // Just advance day and re-blend phase from symptoms
    advanceCycleDay();
  }

  state.checkinDone = true;
  // Store symptoms in mood history so symptom model can learn from them
  state.moodHistory.push({
    day: state.cycleDay,
    mood: state.mood,
    energy: state.energy,
    phase: state.phase,
    symptoms: [...state.symptoms],
    date: new Date().toISOString().split('T')[0],
  });
  if (state.moodHistory.length > 90) state.moodHistory = state.moodHistory.slice(-90);

  // Live update symptom weights based on confirmed phase
  // (gentle Bayesian update — not just overwrite)
  if (state.symptoms.length > 0 && state.cycle.confidence > 0.5) {
    state.symptoms.forEach(sym => {
      if (!state.cycle.symptomWeights[sym]) {
        state.cycle.symptomWeights[sym] = { menstrual:0.25, follicular:0.25, ovulatory:0.25, luteal:0.25 };
      }
      const w = state.cycle.symptomWeights[sym];
      const alpha = 0.08; // small learning rate for symptom weights
      const ph = state.phase;
      Object.keys(w).forEach(p => {
        w[p] = p === ph
          ? Math.min(0.95, w[p] + alpha)
          : Math.max(0.05, w[p] - alpha * 0.3);
      });
    });
  }

  invalidateML();
  evaluateBadges();
  // Feed the pet — check-ins are worth 15 health
  feedPet(15);
  saveState();
  renderToday();
  goTo('today', 'left');
  showToast('✨ Check-in saved! Cycle model updated.');
}

// ═══════════════════════════════════════════
// WORKOUT SCREEN
// ═══════════════════════════════════════════
let currentWorkout = null;
let currentExerciseIdx = 0;
let setData = [];         // [{load, reps, done}] for current exercise
let perExerciseSets = {}; // {exKey: [{load, reps, done}]} accumulated across exercises
let restDuration = 120;   // countdown duration in seconds
let restCountdown = 0;
let restTimerInterval = null;
let restTimerPaused = false;
let workoutStartTime = null;
let sessionRPEs = [];
let customExercises = []; // kept for legacy refs; mirrors customDays[currentCustomDay]
let customDays = [[]];   // multi-day custom plan: array of exercise-key arrays
let currentCustomDay = 0; // which day tab is active in custom builder
let activeSplitDayCount = 4; // selected split count in splits tab

// Coaching cues per exercise type
const COACHING_CUES = {
  squat:    ['Drive through your heels, chest tall', 'Brace your core before you descend', 'Knees track over toes — no caving'],
  deadlift: ['Hinge at the hips, keep bar close', 'Engage lats before you pull', 'Push the floor away, don\'t yank'],
  press:    ['Elbows at 45°, not flared wide', 'Full ROM — touch chest, lock out at top', 'Shoulder blades retracted and depressed'],
  pull:     ['Lead with elbows, not hands', 'Squeeze shoulder blades at the top', 'Control the eccentric — 2 seconds down'],
  hinge:    ['Soft knee, neutral spine throughout', 'Push hips back, not down', 'Feel the hamstring stretch at the bottom'],
  machine:  ['Controlled tempo — 2 up, 3 down', 'Full range of motion every rep', 'Don\'t lock out joints at end range'],
  lunge:    ['Front shin stays vertical', 'Torso upright, don\'t lean forward', 'Drive through front heel to stand'],
  default:  ['Focus on full range of motion', 'Quality reps over speed', 'Breathe out on exertion'],
};

function getCue(exKey) {
  const ex = EXERCISE_DB[exKey] || EXERCISES[exKey] || {};
  const name = (ex.name || exKey || '').toLowerCase();
  let cueKey = 'default';
  if (name.includes('squat'))    cueKey = 'squat';
  else if (name.includes('deadlift')) cueKey = 'deadlift';
  else if (name.includes('press') || name.includes('push')) cueKey = 'press';
  else if (name.includes('row') || name.includes('pull') || name.includes('curl')) cueKey = 'pull';
  else if (name.includes('rdl') || name.includes('hinge') || name.includes('hip thrust')) cueKey = 'hinge';
  else if (name.includes('machine') || name.includes('cable') || name.includes('extension') || name.includes('curl')) cueKey = 'machine';
  else if (name.includes('lunge') || name.includes('split')) cueKey = 'lunge';
  const cues = COACHING_CUES[cueKey];
  return cues[Math.floor(Math.random() * cues.length)];
}

function renderWorkout() {
  const phase = PHASES[state.phase];
  const workout = getWorkout();
  currentWorkout = workout;

  const wh = document.getElementById('workout-hero');
  wh.style.background = workout.color;
  document.getElementById('wh-emoji').textContent = workout.emoji;
  document.getElementById('wh-label').textContent = `${phase.name} Phase · ${phase.icon}`;
  document.getElementById('wh-title').textContent = workout.name;
  document.getElementById('wh-reason').textContent = workout.reason;
  document.getElementById('wh-duration-pill').textContent = workout.duration;
  document.getElementById('wh-intensity-pill').textContent = workout.intensity;
  document.getElementById('wh-type-pill').textContent = workout.type;

  // Show deload banner if triggered
  const deloadBanner = document.getElementById('deload-banner');
  if (deloadBanner) deloadBanner.style.display = needsDeload() ? 'block' : 'none';

  const list = document.getElementById('exercise-list');
  list.innerHTML = '';

  // Use enriched exerciseEntries if available, else fall back to legacy
  const entries = workout.exerciseEntries || workout.exercises.map(k => {
    const ex = EXERCISE_DB[k] || EXERCISES[k];
    return ex ? { ...ex, key:k, targetLoad: null, isProgression: false, progressionLabel: '' } : null;
  }).filter(Boolean);

  entries.forEach((entry, i) => {
    if (!entry) return;
    const div = document.createElement('div');
    div.className = 'exercise-item';
    div.style.animationDelay = (i * 0.06) + 's';

    const progressBadge = entry.isProgression
      ? `<span style="font-size:9px;background:#E8F5EE;color:var(--sage-d);padding:2px 7px;border-radius:100px;font-weight:700;margin-left:4px">↑ overload</span>`
      : entry.progressionLabel && entry.progressionLabel.startsWith('↓')
      ? `<span style="font-size:9px;background:#FDE8EE;color:var(--rose-d);padding:2px 7px;border-radius:100px;font-weight:700;margin-left:4px">↓ deload</span>`
      : '';

    const loadHint = entry.targetLoad > 0
      ? `<span style="font-size:10px;color:var(--mid);font-weight:600"> · ~${entry.targetLoad}kg</span>`
      : '';

    const setsText = entry.sets || `${entry.baseSets||3} × ${entry.baseReps||10}`;
    div.innerHTML = `
      <div class="ei-icon" style="background:${entry.color||'#EDE8F5'}">${entry.icon||'🏋️'}</div>
      <div class="ei-info">
        <div class="ei-name">${entry.name}${progressBadge}</div>
        <div class="ei-detail">${entry.detail}${loadHint}</div>
      </div>
      <div class="ei-sets">
        <span class="ei-sets-num">${setsText.split(' ')[0]}</span>
        <span class="ei-sets-label">${setsText.split(' ').slice(1).join(' ')}</span>
      </div>`;
    list.appendChild(div);
  });

  // Rotation indicator
  const rotNote = document.getElementById('rotation-note');
  if (rotNote) {
    const freshMuscles = workout.musclesToLog || [];
    rotNote.textContent = `Training: ${freshMuscles.join(' · ')}`;
  }
}

function startActiveWorkout() {
  currentExerciseIdx = 0;
  workoutStartTime = Date.now();
  sessionRPEs = [];
  perExerciseSets = {};
  setData = [];
  renderActiveExercise();
  document.getElementById('active-workout').classList.add('open');
  document.body.style.overflow = 'hidden';
}

function renderActiveExercise() {
  // Use exerciseEntries (phase-scaled) if available, fall back to EXERCISES
  const entries = currentWorkout.exerciseEntries || [];
  const entry = entries[currentExerciseIdx];
  const exKey = currentWorkout.exercises[currentExerciseIdx];
  if (!entry && !exKey) return;

  const name = entry ? entry.name : (EXERCISES[exKey] || {}).name || exKey;
  const detail = entry ? entry.detail : '';
  const setsStr = entry ? entry.sets : '3 × 10';
  const targetLoad = (entry && entry.targetLoad > 0) ? entry.targetLoad : 0;
  const hasLoad = targetLoad > 0;

  const total = currentWorkout.exercises.length;

  // Parse "3 × 10" → numSets=3, targetReps=10
  const setsMatch = setsStr.match(/(\d+)\s*[×x]\s*([\d.]+)/);
  const numSets = setsMatch ? parseInt(setsMatch[1]) : 3;
  const targetReps = setsMatch ? parseInt(setsMatch[2]) : 10;

  // Header
  document.getElementById('aw-prog-text').textContent = `Exercise ${currentExerciseIdx + 1} of ${total}`;
  document.getElementById('aw-ex-name').textContent = name;
  document.getElementById('aw-sets-info').textContent = `${setsStr} · ${detail}`;
  document.getElementById('aw-prog-fill').style.width = ((currentExerciseIdx + 1) / total * 100) + '%';
  document.getElementById('aw-hero-header').style.background = currentWorkout.color;

  // Coaching cue
  document.getElementById('aw-cue-icon').textContent = ['💡','🎯','⚡️','✨'][currentExerciseIdx % 4];
  document.getElementById('aw-cue-text').textContent = getCue(exKey);

  // Phase/progression note
  const ml = getMLResult();
  const note = document.getElementById('st-load-note');
  if (entry && entry.isProgression) {
    note.textContent = entry.progressionLabel || '↑ progressive overload';
    note.style.color = 'var(--sage-d)';
  } else if (entry && entry.progressionLabel && entry.progressionLabel.startsWith('↓')) {
    note.textContent = entry.progressionLabel;
    note.style.color = 'var(--rose-d)';
  } else if (ml.modifier.action === 'PR_WINDOW') {
    note.textContent = '⚡️ Peak phase — try pushing load today';
    note.style.color = 'var(--peach)';
  } else if (ml.modifier.volumeMod <= -20) {
    note.textContent = '🍃 Lighter load recommended today';
    note.style.color = 'var(--sage-d)';
  } else {
    note.textContent = '';
  }

  // Build per-set data pre-filled from target
  setData = Array.from({length: numSets}, () => ({
    load: targetLoad,
    reps: targetReps,
    done: false
  }));

  // Render vertical set rows
  const list = document.getElementById('sets-list');
  list.innerHTML = '';
  setData.forEach((s, i) => {
    const row = document.createElement('div');
    row.className = 'set-row';
    row.id = `set-row-${i}`;

    const weightBlock = hasLoad
      ? `<div class="set-input-group">
           <input type="number" step="2.5" min="0" inputmode="decimal" class="set-weight-input" id="set-weight-${i}" value="${s.load}">
           <span class="set-input-unit">kg</span>
         </div>
         <div class="set-sep">×</div>`
      : `<div class="set-bw-label">BW ×</div>`;

    row.innerHTML = `
      <div class="set-num">${i + 1}</div>
      <div class="set-inputs">
        ${weightBlock}
        <div class="set-input-group">
          <input type="number" step="1" min="1" inputmode="numeric" class="set-reps-input" id="set-reps-${i}" value="${s.reps}">
          <span class="set-input-unit">reps</span>
        </div>
      </div>
      <button class="set-done-btn" id="set-done-${i}" onclick="markSetDone(${i})" aria-label="Mark set done">✓</button>`;
    list.appendChild(row);
  });

  // RPE scale
  const rpeScale = document.getElementById('rpe-scale');
  const rpeDescriptions = ['','Very easy','Easy','Moderate','Somewhat hard','Hard','Hard','Very hard','Very hard','Maximal','Absolute max'];
  const rpeColors = ['','#B8D4C0','#B8D4C0','#C9B8E8','#C9B8E8','#F9C9A3','#F9C9A3','#F2A7B4','#F2A7B4','#E8849A','#E8849A'];
  rpeScale.innerHTML = '';
  for (let r = 1; r <= 10; r++) {
    const btn = document.createElement('button');
    btn.className = 'rpe-btn';
    btn.textContent = r;
    btn.style.background = rpeColors[r];
    btn.style.color = 'white';
    btn.style.opacity = '.6';
    btn.onclick = () => {
      rpeScale.querySelectorAll('.rpe-btn').forEach(b => b.style.opacity = '.5');
      btn.style.opacity = '1';
      btn.style.transform = 'scale(1.15)';
      document.getElementById('rpe-value').textContent = `RPE ${r} · ${rpeDescriptions[r]}`;
      sessionRPEs.push(r);
    };
    rpeScale.appendChild(btn);
  }
  document.getElementById('rpe-value').textContent = 'RPE — tap to rate';

  const isLast = currentExerciseIdx === total - 1;
  document.getElementById('next-ex-btn').textContent = isLast ? 'Finish workout 🎉' : 'Next exercise →';
}

function updateSetData(idx) {
  const wEl = document.getElementById(`set-weight-${idx}`);
  const rEl = document.getElementById(`set-reps-${idx}`);
  if (setData[idx]) {
    if (wEl) setData[idx].load = parseFloat(wEl.value) || 0;
    if (rEl) setData[idx].reps = parseInt(rEl.value) || 1;
  }
}

function markSetDone(idx) {
  updateSetData(idx);
  const wasDone = setData[idx].done;
  setData[idx].done = !wasDone;
  const row = document.getElementById(`set-row-${idx}`);
  if (row) row.classList.toggle('done', setData[idx].done);
  if (setData[idx].done) {
    showRestOverlay(idx);
  }
}

function showRestOverlay(completedSetIdx) {
  const overlay = document.getElementById('rest-overlay');
  overlay.classList.add('open');
  document.body.style.overflow = 'hidden';

  const s = setData[completedSetIdx];
  const entry = (currentWorkout.exerciseEntries || [])[currentExerciseIdx];
  const exName = entry ? entry.name : '';
  const hasLoad = s.load > 0;

  document.getElementById('rest-edit-card').innerHTML = `
    <div class="rest-edit-label">Set ${completedSetIdx + 1} · ${exName}</div>
    <div class="rest-edit-inputs">
      ${hasLoad ? `<div class="rest-edit-group">
        <input type="number" step="2.5" min="0" inputmode="decimal" class="rest-edit-input" id="rest-weight-input" value="${s.load}">
        <span class="rest-edit-unit">kg</span>
      </div><div class="rest-edit-sep">×</div>` : ''}
      <div class="rest-edit-group">
        <input type="number" step="1" min="1" inputmode="numeric" class="rest-edit-input" id="rest-reps-input" value="${s.reps}">
        <span class="rest-edit-unit">reps</span>
      </div>
    </div>`;

  // Sync edits back to setData + main row
  const wIn = document.getElementById('rest-weight-input');
  const rIn = document.getElementById('rest-reps-input');
  if (wIn) wIn.oninput = () => {
    setData[completedSetIdx].load = parseFloat(wIn.value) || 0;
    const m = document.getElementById(`set-weight-${completedSetIdx}`);
    if (m) m.value = wIn.value;
  };
  if (rIn) rIn.oninput = () => {
    setData[completedSetIdx].reps = parseInt(rIn.value) || 1;
    const m = document.getElementById(`set-reps-${completedSetIdx}`);
    if (m) m.value = rIn.value;
  };

  // Reset and start countdown
  restTimerPaused = false;
  restCountdown = restDuration;
  document.getElementById('rest-pause-btn').textContent = '⏸ Pause';
  updateRestDisplay();
  clearInterval(restTimerInterval);
  restTimerInterval = setInterval(() => {
    if (restTimerPaused) return;
    restCountdown--;
    updateRestDisplay();
    if (restCountdown <= 0) {
      clearInterval(restTimerInterval);
      document.getElementById('rest-timer-display').textContent = 'Go!';
      document.getElementById('rest-timer-label').textContent = 'Time to lift ✨';
      document.getElementById('rest-timer-label').style.color = 'var(--rose)';
      setTimeout(() => skipRest(), 1500);
    }
  }, 1000);
}

function updateRestDisplay() {
  const m = Math.floor(Math.max(0, restCountdown) / 60).toString().padStart(2, '0');
  const s = (Math.max(0, restCountdown) % 60).toString().padStart(2, '0');
  document.getElementById('rest-timer-display').textContent = `${m}:${s}`;
  const lbl = document.getElementById('rest-timer-label');
  if (restCountdown <= 10 && restCountdown > 0) {
    lbl.textContent = 'Almost ready...';
    lbl.style.color = 'var(--rose-d)';
  } else if (restCountdown > 0) {
    lbl.textContent = 'REST';
    lbl.style.color = '';
  }
}

function toggleRestPause() {
  restTimerPaused = !restTimerPaused;
  document.getElementById('rest-pause-btn').textContent = restTimerPaused ? '▶ Resume' : '⏸ Pause';
}

function skipRest() {
  clearInterval(restTimerInterval);
  document.getElementById('rest-overlay').classList.remove('open');
  document.body.style.overflow = 'hidden'; // active workout is still open
}

function setRestDuration(secs) {
  restDuration = secs;
  document.querySelectorAll('#rest-overlay .rest-preset').forEach(b => b.classList.remove('active'));
  const labels = { 60:'1:00', 90:'1:30', 120:'2:00', 180:'3:00' };
  document.querySelectorAll('#rest-overlay .rest-preset').forEach(b => {
    if (b.textContent === labels[secs]) b.classList.add('active');
  });
  restCountdown = secs;
  updateRestDisplay();
}

function nextExercise() {
  // Capture final input values and save
  setData.forEach((_, i) => updateSetData(i));
  const exKey = currentWorkout.exercises[currentExerciseIdx];
  perExerciseSets[exKey] = setData.map(s => ({...s}));

  const total = currentWorkout.exercises.length;
  if (currentExerciseIdx < total - 1) {
    currentExerciseIdx++;
    renderActiveExercise();
  } else {
    finishWorkout();
  }
}

function finishWorkout() {
  clearInterval(restTimerInterval);
  document.getElementById('rest-overlay').classList.remove('open');
  document.getElementById('active-workout').classList.remove('open');
  document.body.style.overflow = '';

  const elapsed = workoutStartTime ? Math.round((Date.now() - workoutStartTime) / 60000) : 20;
  const avgRPEVal = sessionRPEs.length > 0 ? sessionRPEs.reduce((a,b)=>a+b,0)/sessionRPEs.length : 6;
  const avgRPEStr = sessionRPEs.length > 0 ? avgRPEVal.toFixed(1) : '—';

  state.workoutsCompleted++;
  state.streak++;
  state.totalMins += elapsed;
  // Mark today as complete in the week planner
  if (!state.weekCompletions) state.weekCompletions = {};
  const todayISO = new Date().toISOString().split('T')[0];
  state.weekCompletions[todayISO] = true;

  // Track rolling 28-day workout dates for real ACWR and skip-rate calculations
  if (!state.recentWorkoutDates) state.recentWorkoutDates = [];
  if (!state.recentWorkoutDates.includes(todayISO)) state.recentWorkoutDates.push(todayISO);
  const cutoff28 = new Date(Date.now() - 28 * MS_PER_DAY).toISOString().split('T')[0];
  state.recentWorkoutDates = state.recentWorkoutDates.filter(d => d >= cutoff28);

  // Track last session's exercises for variety logic in the next plan
  state.lastWorkoutExercises = (currentWorkout.exercises || []);

  // Save per-exercise history for progression engine (use actual logged loads/reps)
  const tier = getMLResult().modifier.tier;
  (currentWorkout.exercises || []).forEach(key => {
    const sets = perExerciseSets[key] || [];
    const doneSets = sets.filter(s => s.done);
    if (doneSets.length > 0) {
      const avgLoad = doneSets.reduce((a, s) => a + s.load, 0) / doneSets.length;
      const avgReps = Math.round(doneSets.reduce((a, s) => a + s.reps, 0) / doneSets.length);
      saveExHistory(key, { load: avgLoad, reps: avgReps, rpe: avgRPEVal });
    } else {
      const target = computeTarget(key, state.phase, tier);
      saveExHistory(key, { load: target.load, reps: target.reps, rpe: avgRPEVal });
    }
  });
  // Log muscles trained for rotation tracking
  if (currentWorkout.musclesToLog) logMusclesTrained(currentWorkout.musclesToLog);
  // Invalidate so next plan regenerates with fresh history
  invalidateML();

  const kcalNum = parseInt((currentWorkout.kcal||'200').replace(/[^0-9]/g,'')) || 200;

  // Track PRs for badge (any exercise with a new load high)
  if (!state.prHistory) state.prHistory = [];
  (currentWorkout.exercises || []).forEach(key => {
    const h = getExHistory(key);
    if (h.loads.length >= 2) {
      const last = h.loads[h.loads.length - 1];
      const prevBest = Math.max(...h.loads.slice(0, -1));
      if (last > prevBest) {
        state.prHistory.push({ date: new Date().toISOString().split('T')[0], exercise: key, load: last, phase: state.phase });
        if (state.prHistory.length > 20) state.prHistory = state.prHistory.slice(-20);
      }
    }
  });

  // Populate share card
  const phaseGradients = {
    menstrual:  'linear-gradient(160deg,#F2A7B4,#E8849A)',
    follicular: 'linear-gradient(160deg,#C9B8E8,#A896D4)',
    ovulatory:  'linear-gradient(160deg,#F9C9A3,#F0A873)',
    luteal:     'linear-gradient(160deg,#B8D4C0,#8CBF9C)',
  };
  document.getElementById('share-card').style.background = phaseGradients[state.phase] || phaseGradients.follicular;
  document.getElementById('sc-hero-emoji').textContent  = currentWorkout.emoji || '🌸';
  document.getElementById('sc-workout-name').textContent = currentWorkout.name || 'Today\'s Workout';
  document.getElementById('sc-mins-chip').textContent   = `${elapsed} min`;
  document.getElementById('sc-exer-chip').textContent   = `${(currentWorkout.exercises||[]).length} exercises`;
  document.getElementById('sc-kcal-chip').textContent   = `${kcalNum} kcal`;
  document.getElementById('sc-streak-line').textContent = `🔥 ${state.streak}-day streak`;

  const completionMsgs = [
    `You showed up for yourself today. Every session is a vote for who you're becoming. 💕`,
    `${state.name}, that was ${currentWorkout.name}. Your body will thank you. 🌸`,
    `Workout ${state.workoutsCompleted} done. Building something beautiful — one session at a time. ✨`,
    `Bloom logged avg RPE ${avgRPEStr} and will fine-tune your next session accordingly. 💜`,
  ];
  document.getElementById('sc-msg').textContent = completionMsgs[state.workoutsCompleted % completionMsgs.length];

  document.getElementById('completion-overlay').classList.add('open');

  // Evaluate badges after a short delay so the share card is seen first
  setTimeout(() => evaluateBadges(), 700);

  // Feed the pet — workouts are worth 30 health
  feedPet(30);
  saveState();
}

function closeActiveWorkout() {
  clearInterval(restTimerInterval);
  document.getElementById('rest-overlay').classList.remove('open');
  document.getElementById('active-workout').classList.remove('open');
  document.body.style.overflow = '';
}

function closeCompletion() {
  document.getElementById('completion-overlay').classList.remove('open');
  goTo('today', 'left');
}

// ── CUSTOM WORKOUT BUILDER ──────────────────

function openCustomWorkout() {
  customDays = [[]];
  customExercises = customDays[0];
  currentCustomDay = 0;
  activeSplitDayCount = 4;
  document.getElementById('custom-workout-overlay').classList.add('open');
  document.body.style.overflow = 'hidden';
  openCWTab('splits');
  selectSplitDayCount(4);
}

function closeCustomWorkout() {
  document.getElementById('custom-workout-overlay').classList.remove('open');
  document.body.style.overflow = '';
}

function openCWTab(tab) {
  document.getElementById('cw-tab-splits').classList.toggle('active', tab === 'splits');
  document.getElementById('cw-tab-custom').classList.toggle('active', tab === 'custom');
  document.getElementById('cw-panel-splits').style.display = tab === 'splits' ? 'flex' : 'none';
  document.getElementById('cw-panel-custom').style.display = tab === 'custom' ? 'flex' : 'none';
  if (tab === 'custom') {
    renderCustomDayTabs();
    // Reset filter to All
    document.querySelectorAll('#cw-muscle-filter .i-chip').forEach(c => c.classList.remove('active'));
    const first = document.querySelector('#cw-muscle-filter .i-chip');
    if (first) first.classList.add('active');
    renderCWExercises('all');
    renderCWSelected();
  }
}

// ── Splits tab ──

function selectSplitDayCount(n) {
  activeSplitDayCount = n;
  document.querySelectorAll('.split-day-btn').forEach(b => {
    b.classList.toggle('active', parseInt(b.textContent) === n);
  });
  const split = WORKOUT_SPLITS[n];
  if (!split) return;
  const badge = document.getElementById('split-focus-badge');
  if (badge) badge.textContent = split.emoji + ' ' + split.focus;
  renderSplitCards(n);
}

function renderSplitCards(n) {
  const split = WORKOUT_SPLITS[n];
  if (!split) return;
  const container = document.getElementById('split-cards-container');
  container.innerHTML = '';
  split.days.forEach((day, idx) => {
    const preview = day.exercises.slice(0, 3).map(key => {
      const ex = EXERCISE_DB[key];
      return ex ? `<span class="split-ex-pill">${ex.icon} ${ex.name}</span>` : '';
    }).join('');
    const more = day.exercises.length > 3
      ? `<span class="split-more-pill">+${day.exercises.length - 3} more</span>` : '';
    const card = document.createElement('div');
    card.className = 'split-day-card';
    card.innerHTML = `
      <div class="split-card-num">Day ${idx + 1}</div>
      <div class="split-card-name">${day.emoji} ${day.name}</div>
      <div class="split-card-tag">${day.tag}</div>
      <div class="split-card-pills">${preview}${more}</div>
      <button class="split-start-btn" onclick="startSplitDay(${n},${idx})">Start Day ${idx + 1} →</button>`;
    container.appendChild(card);
  });
}

function startSplitDay(splitN, dayIdx) {
  const split = WORKOUT_SPLITS[splitN];
  if (!split) return;
  const day = split.days[dayIdx];
  if (!day) return;
  const phase = state.phase;
  const tier = getMLResult().modifier.tier;
  const phaseColors = {
    menstrual:  'linear-gradient(135deg,#F2A7B4,#E8849A)',
    follicular: 'linear-gradient(135deg,#C9B8E8,#A896D4)',
    ovulatory:  'linear-gradient(135deg,#F9C9A3,#F0A873)',
    luteal:     'linear-gradient(135deg,#B8D4C0,#8CBF9C)',
  };
  const exerciseEntries = day.exercises.map(key => {
    const ex = EXERCISE_DB[key];
    if (!ex) return null;
    const target = computeTarget(key, phase, tier);
    const repsLabel = (ex.muscle === 'core' && ex.name.includes('Plank')) ? `${target.reps} sec` : `${target.reps}`;
    return { ...ex, key, sets:`${target.sets} × ${repsLabel}`, targetLoad:target.load, isProgression:target.isProgression, progressionLabel:target.label };
  }).filter(Boolean);
  const uniqueMuscles = [...new Set(day.exercises.map(k => (EXERCISE_DB[k] || {}).muscle).filter(Boolean))];
  currentWorkout = {
    name: `${split.name} · Day ${dayIdx + 1}`,
    emoji: day.emoji, type: split.focus,
    color: phaseColors[phase] || phaseColors.follicular,
    exercises: [...day.exercises], exerciseEntries,
    musclesToLog: uniqueMuscles,
    duration: `~${Math.round(day.exercises.length * 4.5)} min`,
    intensity: tier,
    kcal: `~${Math.round(day.exercises.length * 35)}`,
    reason: `${split.name} · ${day.name} · adapted to your phase`,
  };
  closeCustomWorkout();
  startActiveWorkout();
}

// ── Custom tab ──

function renderCustomDayTabs() {
  const row = document.getElementById('cw-day-tabs-row');
  const removeBtn = document.getElementById('cw-remove-day-btn');
  row.innerHTML = '';
  customDays.forEach((_, idx) => {
    const btn = document.createElement('button');
    btn.className = 'cw-day-tab' + (idx === currentCustomDay ? ' active' : '');
    btn.textContent = `Day ${idx + 1}`;
    btn.onclick = () => switchCustomDay(idx);
    row.appendChild(btn);
  });
  if (removeBtn) removeBtn.style.display = customDays.length > 1 ? 'inline-flex' : 'none';
}

function switchCustomDay(idx) {
  currentCustomDay = idx;
  customExercises = customDays[idx];
  renderCustomDayTabs();
  document.querySelectorAll('#cw-muscle-filter .i-chip').forEach(c => c.classList.remove('active'));
  const first = document.querySelector('#cw-muscle-filter .i-chip');
  if (first) first.classList.add('active');
  renderCWExercises('all');
  renderCWSelected();
}

function addCustomDay() {
  customDays.push([]);
  currentCustomDay = customDays.length - 1;
  customExercises = customDays[currentCustomDay];
  renderCustomDayTabs();
  document.querySelectorAll('#cw-muscle-filter .i-chip').forEach(c => c.classList.remove('active'));
  const first = document.querySelector('#cw-muscle-filter .i-chip');
  if (first) first.classList.add('active');
  renderCWExercises('all');
  renderCWSelected();
}

function removeCustomDay() {
  if (customDays.length <= 1) return;
  customDays.splice(currentCustomDay, 1);
  currentCustomDay = Math.min(currentCustomDay, customDays.length - 1);
  customExercises = customDays[currentCustomDay];
  renderCustomDayTabs();
  renderCWExercises('all');
  renderCWSelected();
}

function filterCWExercises(muscle, el) {
  document.querySelectorAll('#cw-muscle-filter .i-chip').forEach(c => c.classList.remove('active'));
  el.classList.add('active');
  renderCWExercises(muscle);
}

function renderCWExercises(muscle) {
  const list = document.getElementById('cw-exercise-list');
  if (!list) return;
  list.innerHTML = '';
  const dayEx = customDays[currentCustomDay] || [];
  Object.entries(EXERCISE_DB).forEach(([key, ex]) => {
    if (muscle !== 'all' && ex.muscle !== muscle) return;
    const isAdded = dayEx.includes(key);
    const div = document.createElement('div');
    div.className = 'cw-ex-item' + (isAdded ? ' added' : '');
    div.innerHTML = `
      <div class="cw-ex-icon" style="background:${ex.color || '#EDE8F5'}">${ex.icon || '🏋️'}</div>
      <div class="cw-ex-info">
        <div class="cw-ex-name">${ex.name}</div>
        <div class="cw-ex-detail">${ex.detail}</div>
      </div>
      <button class="cw-add-btn ${isAdded ? 'remove' : 'add'}" onclick="toggleCWExercise('${key}')">${isAdded ? '−' : '+'}</button>`;
    list.appendChild(div);
  });
}

function toggleCWExercise(key) {
  const dayEx = customDays[currentCustomDay] || [];
  const idx = dayEx.indexOf(key);
  if (idx >= 0) dayEx.splice(idx, 1);
  else dayEx.push(key);
  customExercises = dayEx;
  const activeChip = document.querySelector('#cw-muscle-filter .i-chip.active');
  const label = activeChip ? activeChip.textContent.toLowerCase() : 'all';
  const muscleMap = { all:'all', quads:'quads', glutes:'glutes', back:'back', chest:'chest', shoulders:'shoulders', core:'core', hamstrings:'hamstring', calves:'calves', biceps:'biceps', triceps:'triceps' };
  renderCWExercises(muscleMap[label] || label);
  renderCWSelected();
}

function renderCWSelected() {
  const list = document.getElementById('cw-selected-list');
  const count = document.getElementById('cw-count');
  const btn = document.getElementById('cw-start-btn');
  const dayEx = customDays[currentCustomDay] || [];
  if (count) count.textContent = `(${dayEx.length})`;
  if (btn) btn.disabled = dayEx.length === 0;

  if (dayEx.length === 0) {
    list.innerHTML = '<div class="cw-empty">No exercises added yet. Pick from the list below.</div>';
    return;
  }
  list.innerHTML = '';
  dayEx.forEach(key => {
    const ex = EXERCISE_DB[key];
    if (!ex) return;
    const target = computeTarget(key, state.phase, getMLResult().modifier.tier);
    const div = document.createElement('div');
    div.className = 'cw-selected-item';
    div.innerHTML = `
      <div class="cw-ex-icon" style="background:${ex.color || '#EDE8F5'}">${ex.icon || '🏋️'}</div>
      <div class="cw-ex-info">
        <div class="cw-ex-name">${ex.name}</div>
        <div class="cw-ex-detail">${target.sets} × ${target.reps} reps${target.load > 0 ? ` · ~${target.load}kg` : ''}</div>
      </div>
      <button class="cw-remove-btn" onclick="toggleCWExercise('${key}')">×</button>`;
    list.appendChild(div);
  });
}

function startCustomWorkout() {
  const dayEx = customDays[currentCustomDay] || [];
  if (dayEx.length === 0) return;
  const phase = state.phase;
  const tier = getMLResult().modifier.tier;
  const phaseColors = {
    menstrual:  'linear-gradient(135deg,#F2A7B4,#E8849A)',
    follicular: 'linear-gradient(135deg,#C9B8E8,#A896D4)',
    ovulatory:  'linear-gradient(135deg,#F9C9A3,#F0A873)',
    luteal:     'linear-gradient(135deg,#B8D4C0,#8CBF9C)',
  };
  const exerciseEntries = dayEx.map(key => {
    const ex = EXERCISE_DB[key];
    if (!ex) return null;
    const target = computeTarget(key, phase, tier);
    const repsLabel = (ex.muscle === 'core' && ex.name.includes('Plank')) ? `${target.reps} sec` : `${target.reps}`;
    return { ...ex, key, sets:`${target.sets} × ${repsLabel}`, targetLoad:target.load, isProgression:target.isProgression, progressionLabel:target.label };
  }).filter(Boolean);
  const uniqueMuscles = [...new Set(dayEx.map(k => (EXERCISE_DB[k] || {}).muscle).filter(Boolean))];
  const dayLabel = customDays.length > 1 ? ` · Day ${currentCustomDay + 1}` : '';
  currentWorkout = {
    name: `Custom Workout${dayLabel}`, emoji: '💪', type: 'Custom',
    color: phaseColors[phase] || phaseColors.follicular,
    exercises: [...dayEx], exerciseEntries,
    musclesToLog: uniqueMuscles,
    duration: '— min', intensity: '—', kcal: '~0',
    reason: 'Your own plan · adapted to your phase',
  };
  closeCustomWorkout();
  startActiveWorkout();
}

// ═══════════════════════════════════════════
// PROGRESS SCREEN
// ═══════════════════════════════════════════
function renderProgress() {
  document.getElementById('stat-workouts').textContent = state.workoutsCompleted;
  document.getElementById('stat-streak').textContent = state.streak;
  document.getElementById('stat-listens').textContent = state.listenedToBody;
  document.getElementById('stat-mins').textContent = state.totalMins;

  const phaseColors = { menstrual:'#F2A7B4', follicular:'#C9B8E8', ovulatory:'#F9C9A3', luteal:'#B8D4C0' };

  // ── Strength chart: real load progression from most-trained exercise ──
  const chart = document.getElementById('strength-chart');
  const xlabels = document.getElementById('strength-x-labels');
  const chartSub = document.querySelector('#screen-progress .chart-card .chart-sub');
  const prBadge = document.getElementById('chart-pr-badge');
  const exHistory = state.exerciseHistory || {};
  const exKeys = Object.keys(exHistory).filter(k => (exHistory[k].loads || []).length > 0);
  if (exKeys.length === 0) {
    chart.innerHTML = '<div style="width:100%;text-align:center;padding:24px 0;font-size:13px;color:var(--light)">Complete workouts to see your strength progress</div>';
    xlabels.innerHTML = '';
    if (chartSub) chartSub.textContent = 'No workout data yet';
    if (prBadge) prBadge.style.display = 'none';
  } else {
    const bestKey = exKeys.reduce((a, b) => (exHistory[a].loads.length >= exHistory[b].loads.length ? a : b));
    const exData = exHistory[bestKey];
    const loads = exData.loads.slice(-8);
    const maxLoad = Math.max(...loads);
    const minLoad = Math.min(...loads);
    const exName = EXERCISE_DB[bestKey]?.name || bestKey;
    const gain = loads.length > 1 ? Math.round((loads[loads.length - 1] - loads[0]) * 10) / 10 : 0;
    if (chartSub) chartSub.textContent = `${exName} · last ${loads.length} session${loads.length !== 1 ? 's' : ''}`;
    if (prBadge) {
      prBadge.style.display = gain > 0 ? '' : 'none';
      prBadge.textContent = `+${gain} kg 📈`;
    }
    chart.innerHTML = loads.map((kg, i) => {
      const range = maxLoad - minLoad || 1;
      const hPct = Math.round(((kg - minLoad) / range) * 70 + 20);
      const isPR = kg === maxLoad && i === loads.lastIndexOf(maxLoad);
      return `<div class="sc-bar-wrap">
        <div class="sc-bar-kg">${Math.round(kg)}</div>
        <div class="sc-bar${isPR ? ' pr-dot' : ''}" style="height:${hPct}%;background:${phaseColors[state.phase || 'follicular']}"></div>
      </div>`;
    }).join('');
    xlabels.innerHTML = loads.map((_, i) => `<span>S${i + 1}</span>`).join('');
  }

  // ── Phase breakdown: average mood score per phase from moodHistory ──
  const phaseMoodData = { menstrual:[], follicular:[], ovulatory:[], luteal:[] };
  (state.moodHistory || []).forEach(entry => {
    if (entry.phase && phaseMoodData[entry.phase] && entry.mood) {
      const score = Math.round((entry.mood / 5) * 100 * 0.7 + ((entry.energy || 5) / 10) * 100 * 0.3);
      phaseMoodData[entry.phase].push(score);
    }
  });
  // Fall back to current ML score for the current phase if no history yet
  const currentMLScore = getMLResult().readiness.score;
  const phaseScores = {};
  Object.keys(phaseMoodData).forEach(ph => {
    if (phaseMoodData[ph].length > 0) {
      phaseScores[ph] = Math.round(phaseMoodData[ph].reduce((a, b) => a + b, 0) / phaseMoodData[ph].length);
    } else {
      phaseScores[ph] = ph === state.phase ? currentMLScore : null;
    }
  });
  const breakdown = document.getElementById('phase-breakdown');
  breakdown.innerHTML = Object.entries(phaseScores).map(([ph, score]) => {
    if (score === null) {
      return `<div class="pb-row">
        <span class="pb-phase" style="color:${phaseColors[ph]}">${PHASES[ph].icon} ${PHASES[ph].name}</span>
        <div class="pb-bar-bg"><div class="pb-bar" style="width:0%;background:${phaseColors[ph]}" data-w="0%"></div></div>
        <span class="pb-score" style="color:var(--light)">—</span>
      </div>`;
    }
    return `<div class="pb-row">
      <span class="pb-phase" style="color:${phaseColors[ph]}">${PHASES[ph].icon} ${PHASES[ph].name}</span>
      <div class="pb-bar-bg"><div class="pb-bar" style="width:0%;background:${phaseColors[ph]}" data-w="${score}%"></div></div>
      <span class="pb-score">${score}</span>
    </div>`;
  }).join('');
  setTimeout(() => {
    breakdown.querySelectorAll('.pb-bar').forEach(b => {
      b.style.transition = 'width .8s cubic-bezier(.4,0,.2,1)';
      b.style.width = b.getAttribute('data-w');
    });
  }, 100);

  // ── Weekly activity chart: active days per week from moodHistory ──
  const today = new Date();
  const moodByDate = {};
  (state.moodHistory || []).forEach(e => { if (e.date) moodByDate[e.date] = e; });
  const weekData = Array.from({ length: 7 }, (_, w) => {
    const weekEnd = new Date(today);
    weekEnd.setDate(today.getDate() - w * 7);
    const weekStart = new Date(weekEnd);
    weekStart.setDate(weekEnd.getDate() - 6);
    let activeDays = 0;
    let dominantPhase = 'follicular';
    const phaseCounts = {};
    for (let d = new Date(weekStart); d <= weekEnd; d.setDate(d.getDate() + 1)) {
      const ds = d.toISOString().split('T')[0];
      if (moodByDate[ds]) {
        activeDays++;
        const ph = moodByDate[ds].phase;
        if (ph) phaseCounts[ph] = (phaseCounts[ph] || 0) + 1;
      }
    }
    const topPhase = Object.keys(phaseCounts).sort((a, b) => phaseCounts[b] - phaseCounts[a])[0];
    if (topPhase) dominantPhase = topPhase;
    return { label: w === 0 ? 'This wk' : `${w}w ago`, val: activeDays, phase: dominantPhase };
  }).reverse();
  const maxDays = Math.max(...weekData.map(d => d.val), 1);
  document.getElementById('weekly-chart').innerHTML = weekData.map(d => `
    <div class="bar-wrap">
      <div class="bar-val">${d.val > 0 ? d.val : ''}</div>
      <div class="bar" style="height:${Math.round((d.val / maxDays) * 100)}%;background:${d.val > 0 ? phaseColors[d.phase] : '#f0f0f0'}"></div>
      <div class="bar-label">${d.label}</div>
    </div>`).join('');

  // ── Mood heatmap: last 28 calendar days, real data only ──
  const hm = document.getElementById('mood-heatmap');
  const moodOpacities = [0.2, 0.35, 0.5, 0.7, 0.9];
  hm.innerHTML = Array.from({ length: 28 }, (_, i) => {
    const d = new Date(today);
    d.setDate(today.getDate() - (27 - i));
    const ds = d.toISOString().split('T')[0];
    const entry = moodByDate[ds];
    if (entry && entry.mood) {
      const ph = entry.phase || 'follicular';
      const opacity = moodOpacities[(entry.mood - 1)] || 0.4;
      return `<div class="hm-cell" style="background:${phaseColors[ph]};opacity:${opacity}" title="${ds}: Mood ${entry.mood}/5"></div>`;
    }
    return `<div class="hm-cell" style="background:#e8e8e8;opacity:0.4" title="${ds}: No check-in"></div>`;
  }).join('');

  // ── Celebration ──
  const texts = [
    `"You haven't started your first workout yet — but you're here. That's the first step. 🌸"`,
    `"${state.workoutsCompleted} workout${state.workoutsCompleted !== 1 ? 's' : ''} done. You're building a rhythm your body will thank you for. 💕"`,
    `"${state.listenedToBody} rest day${state.listenedToBody !== 1 ? 's' : ''} chosen wisely. Recovery is training. 🍃"`,
    `"${state.streak}-day streak 🔥 and ${state.listenedToBody} smart rest days. That balance is everything. ✨"`,
  ];
  document.getElementById('celebration-text').textContent = texts[Math.min(state.workoutsCompleted, texts.length - 1)];

  // Badge wall
  const badgeGrid = document.getElementById('badge-grid');
  if (badgeGrid) badgeGrid.innerHTML = getBadgeWallHTML();
}

// ═══════════════════════════════════════════
// LEARN SCREEN
// ═══════════════════════════════════════════
function renderLearnCards() { renderEstrogen(); }

function filterLearn(cat, el) {
  document.querySelectorAll('.i-chip').forEach(c => c.classList.remove('active'));
  el.classList.add('active');
  document.querySelectorAll('.learn-card').forEach(card => {
    card.style.display = (cat === 'all' || card.dataset.cat === cat) ? 'block' : 'none';
  });
}

function toggleLearnCard(headerEl) {
  const body = headerEl.parentElement.querySelector('.lc-body');
  if (!body) return;
  body.classList.toggle('open');
  renderEstrogen();
}

function renderEstrogen() {
  const el = document.getElementById('estrogen-chart');
  if (!el) return;
  const vals = [10,30,70,100,90,60,40,20,15,10];
  el.innerHTML = vals.map(v => `<div class="hc-bar" style="height:${v}%;background:linear-gradient(to top,#C9B8E8,#F2A7B4)"></div>`).join('');
}

// ═══════════════════════════════════════════
// TOAST
// ═══════════════════════════════════════════
function showToast(msg) {
  let toast = document.getElementById('toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toast';
    toast.style.cssText = `position:fixed;bottom:100px;left:50%;transform:translateX(-50%);background:var(--ink);color:white;padding:10px 20px;border-radius:100px;font-size:13px;font-weight:600;font-family:'Nunito',sans-serif;z-index:500;white-space:nowrap;box-shadow:0 8px 24px rgba(46,31,42,.3);transition:all .3s;`;
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.style.opacity = '1';
  toast.style.transform = 'translateX(-50%) translateY(0)';
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(-50%) translateY(10px)';
  }, 2800);
}

// ═══════════════════════════════════════════
// FIREBASE — wired via modular SDK bridge
// ═══════════════════════════════════════════
let currentUser = null;
let lastSyncTime = null;
let onboardingCompleted = !!localStorage.getItem('bloom_onboarding_done');

// Called by the Firebase module once auth state resolves.
// The module loads AFTER this main script, so this is always defined first.
window._onAuthStateChanged = async (user) => {
  window._firebaseCallbackReceived = true;
  currentUser = user;
  if (user) {
    updateAccountUI(user);
    await cloudLoadState();
    document.getElementById('screen-auth')?.classList.remove('active');
    document.getElementById('bottom-nav').style.display = 'flex';
    if (!state.phase) advanceCycleDay();
    decayPetHealth();
    goTo('today');
  } else {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById('bottom-nav').style.display = 'none';
    if (onboardingCompleted) {
      document.getElementById('screen-auth').classList.add('active');
    } else {
      document.getElementById('screen-onboarding').classList.add('active');
    }
  }
};

// ── Auth actions ──
let authMode = 'login';

function switchAuthTab(mode) {
  authMode = mode;
  document.querySelectorAll('.auth-tab').forEach((t, i) => {
    t.classList.toggle('active', (i === 0 && mode === 'login') || (i === 1 && mode === 'signup'));
  });
  const btn = document.getElementById('auth-submit-btn');
  const pwInput = document.getElementById('auth-password');
  if (mode === 'signup') {
    btn.textContent = 'Create account →';
    if (!document.getElementById('auth-password-confirm')) {
      const conf = document.createElement('input');
      conf.id = 'auth-password-confirm';
      conf.type = 'password';
      conf.placeholder = 'Confirm password';
      conf.className = 'auth-input';
      conf.autocomplete = 'new-password';
      pwInput.insertAdjacentElement('afterend', conf);
    }
  } else {
    btn.textContent = 'Sign in →';
    document.getElementById('auth-password-confirm')?.remove();
  }
  document.getElementById('auth-error').textContent = '';
}

function setAuthError(msg) {
  document.getElementById('auth-error').textContent = msg;
}

async function authSubmit() {
  const email    = document.getElementById('auth-email').value.trim();
  const password = document.getElementById('auth-password').value;
  const btn      = document.getElementById('auth-submit-btn');
  if (!email || !password) { setAuthError('Please fill in all fields'); return; }

  btn.textContent = '...'; btn.disabled = true;
  try {
    if (authMode === 'signup') {
      const conf = document.getElementById('auth-password-confirm')?.value;
      if (conf && conf !== password) {
        setAuthError("Passwords don't match");
        btn.textContent = 'Create account →'; btn.disabled = false; return;
      }
      await window._fbSignUp(email, password);
    } else {
      await window._fbSignIn(email, password);
    }
    // _onAuthStateChanged fires automatically
  } catch(e) {
    const msgs = {
      'auth/email-already-in-use': 'An account with this email already exists.',
      'auth/user-not-found':       'No account found with this email.',
      'auth/wrong-password':       'Incorrect password.',
      'auth/weak-password':        'Password should be at least 6 characters.',
      'auth/invalid-email':        'Please enter a valid email address.',
      'auth/invalid-credential':   'Incorrect email or password.',
    };
    setAuthError(msgs[e.code] || 'Something went wrong. Please try again.');
    btn.textContent = authMode === 'signup' ? 'Create account →' : 'Sign in →';
    btn.disabled = false;
  }
}

async function authGoogle() {
  try {
    await window._fbGoogleIn();
  } catch(e) {
    if (e.code !== 'auth/popup-closed-by-user') {
      setAuthError('Google sign-in failed. Try email instead.');
    }
  }
}

async function authSignOut() {
  closeAccount();
  await cloudSaveState();
  await window._fbSignOut();
  localStorage.removeItem('bloom_state');
  Object.assign(state, {
    name:'Sofia', goals:['strength'], level:1, mood:3, energy:6,
    symptoms:[], workoutsCompleted:0, streak:0, listenedToBody:0,
    totalMins:0, moodHistory:[], checkinDone:false, phase:null,
    cycle: getDefaultCycle(),
  });
}

// ── Firestore sync ──
async function cloudSaveState() {
  if (!currentUser || !window._fbSaveState) { saveStateLocal(); return; }
  try {
    const clean = JSON.parse(JSON.stringify(state)); // strip undefined
    await window._fbSaveState(currentUser.uid, clean);
    _stateDirty = false;
    lastSyncTime = new Date();
    updateSyncUI();
    saveStateLocal();
  } catch(e) {
    console.warn('Cloud save failed, keeping local', e);
    saveStateLocal();
  }
}

async function cloudLoadState() {
  if (!currentUser || !window._fbLoadState) return false;
  try {
    const data = await window._fbLoadState(currentUser.uid);
    if (data && data.state) {
      Object.assign(state, data.state);
      if (!state.cycle) state.cycle = getDefaultCycle();
      if (!state.cycle.symptomWeights) state.cycle.symptomWeights = {};
      lastSyncTime = data.updatedAt ? new Date(data.updatedAt.seconds * 1000) : null;
      saveStateLocal();
      invalidateML();
      return true;
    }
  } catch(e) {
    console.warn('Cloud load failed, using local state', e);
  }
  loadStateLocal();
  return false;
}

let _lastManualSync = 0;
let _stateDirty = false;

async function manualCloudSync() {
  if (!_stateDirty) {
    showToast('Already up to date');
    return;
  }
  const now = Date.now();
  if (now - _lastManualSync < 30000) {
    showToast('Synced recently — try again in a moment');
    return;
  }
  _lastManualSync = now;
  // Flush any pending debounced save immediately
  if (_cloudSaveTimer) { clearTimeout(_cloudSaveTimer); _cloudSaveTimer = null; }
  const row = document.getElementById('ac-sync-row');
  if (row) row.disabled = true;
  const textEl = document.getElementById('ac-sync-text');
  if (textEl) textEl.firstChild.textContent = 'Syncing...';
  await cloudSaveState();
  showToast('☁️ Synced to cloud!');
  updateSyncUI();
  setTimeout(() => {
    const r = document.getElementById('ac-sync-row');
    if (r) r.disabled = false;
  }, 30000);
}

function updateSyncUI() {
  const subEl  = document.getElementById('ac-sync-sub');
  const textEl = document.getElementById('ac-sync-text');
  if (subEl && lastSyncTime) {
    const mins = Math.round((Date.now() - lastSyncTime) / 60000);
    subEl.textContent = mins < 1 ? 'Just synced' : mins < 60 ? `${mins}m ago` : 'Synced today';
  }
  if (textEl) textEl.firstChild.textContent = 'Sync to cloud';
}

function updateAccountUI(user) {
  const name     = user.displayName || state.name || 'You';
  const initials = name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);

  const navIcon = document.getElementById('nav-account-icon');
  if (navIcon) {
    navIcon.innerHTML = user.photoURL
      ? `<img src="${user.photoURL}" style="border-radius:50%;width:24px;height:24px;object-fit:cover">`
      : `<span style="font-size:10px;font-weight:700;color:white;background:linear-gradient(135deg,var(--rose),var(--lilac));border-radius:50%;width:24px;height:24px;display:flex;align-items:center;justify-content:center">${initials}</span>`;
  }

  const avEl = document.getElementById('ac-avatar');
  if (avEl) {
    avEl.innerHTML = user.photoURL
      ? `<img src="${user.photoURL}" style="width:56px;height:56px;border-radius:50%;object-fit:cover">`
      : initials;
  }
  const nameEl  = document.getElementById('ac-name');
  const emailEl = document.getElementById('ac-email');
  if (nameEl)  nameEl.textContent  = name;
  if (emailEl) emailEl.textContent = user.email || '';

  if (user.displayName && state.name === 'Sofia') {
    state.name = user.displayName.split(' ')[0];
  }
}

function openAccount()  {
  updateSyncUI();
  document.getElementById('account-sheet').classList.add('open');
}
function closeAccount(e) {
  if (!e || e.target === document.getElementById('account-sheet')) {
    document.getElementById('account-sheet').classList.remove('open');
  }
}

function exportData() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type:'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = 'bloom-data.json'; a.click();
  URL.revokeObjectURL(url);
  showToast('📥 Data exported!');
}

function resetOnboarding() {
  if (!confirm('This will reset your profile settings and cycle data. Your workout history will be kept. Continue?')) return;
  closeAccount();
  localStorage.removeItem('bloom_onboarding_done');
  onboardingCompleted = false;
  daysUntilNextPeriod = null;
  obPeriodSymptoms = [];
  state.name = 'Sofia';
  state.goals = ['strength'];
  state.level = 1;
  state.focusMuscles = [];
  state.trainingDaysPerWeek = 3;
  state.sessionDurationMins = 45;
  state.durationScale = 1;
  state.phase = null;
  state.cycle = getDefaultCycle();
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById('bottom-nav').style.display = 'none';
  document.getElementById('screen-onboarding').classList.add('active');
  obNext(1);
}

async function resetAccount() {
  if (!confirm('This will permanently delete ALL your data — workout history, cycle tracking, progress, badges, everything. This cannot be undone.\n\nAre you absolutely sure?')) return;
  if (!confirm('Last chance. Delete everything and start fresh?')) return;

  closeAccount();
  showToast('Deleting all data…');

  // 1. Wipe Firestore document (prevents cloud data from reloading on next sign-in)
  if (currentUser && window._fbClearState) {
    try { await window._fbClearState(currentUser.uid); } catch(e) { console.warn('Firestore clear failed', e); }
  }

  // 2. Sign out so the wiped cloud state isn't re-saved under this session
  if (currentUser && window._fbSignOut) {
    try { await window._fbSignOut(); } catch(e) {}
  }

  // 3. Nuke ALL localStorage — no partial cleanup
  localStorage.clear();

  // 4. Reset every property on the state object to factory defaults
  Object.keys(state).forEach(k => delete state[k]);
  Object.assign(state, {
    name: 'Sofia', goals: ['strength'], level: 1, mood: 3, energy: 6,
    symptoms: [], workoutsCompleted: 0, streak: 0, listenedToBody: 0,
    totalMins: 0, moodHistory: [], checkinDone: false, phase: null,
    weekSchedule: null, weekScheduleWeek: null, weekCompletions: {},
    badges: [], prHistory: [], pet: null,
    exerciseHistory: {}, muscleLog: {},
    focusMuscles: [], trainingDaysPerWeek: 3,
    sessionDurationMins: 45, durationScale: 1,
    lastWorkoutExercises: [],
    cycle: getDefaultCycle(),
  });

  // 5. Clear all in-memory caches
  invalidateML();
  currentUser = null;
  onboardingCompleted = false;
  daysUntilNextPeriod = null;
  obPeriodSymptoms = [];

  // 6. Back to onboarding
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById('bottom-nav').style.display = 'none';
  document.getElementById('screen-onboarding').classList.add('active');
  obNext(1);
  showToast('All data deleted. Starting fresh.');
}

// ── Offline fallback ──
function offlineInit() {
  window._firebaseCallbackReceived = true; // prevent double-firing timeout
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById('bottom-nav').style.display = 'none';

  const hasSaved = loadStateLocal();
  if (hasSaved && state.phase) {
    if (!state.cycle) state.cycle = getDefaultCycle();
    document.getElementById('bottom-nav').style.display = 'flex';
    advanceCycleDay();
    goTo('today');
    if (!state.cycle.healthKitLinked) {
      tryHealthKitSync().then(linked => {
        if (linked) { renderToday(); showToast('🍎 Cycle data synced from Apple Health'); }
      });
    }
  } else {
    // No saved state — go to onboarding
    document.getElementById('screen-onboarding').classList.add('active');
    state.phase    = state.phase    || 'follicular';
    state.cycleDay = state.cycleDay || 14;
  }
  const nameInput = document.getElementById('name-input');
  if (nameInput && state.name !== 'Sofia') nameInput.value = state.name;
}

// ═══════════════════════════════════════════
// PERSISTENCE (localStorage layer)
// ═══════════════════════════════════════════
let _cloudSaveTimer = null;

function saveState() {
  saveStateLocal(); // always write locally right away — no data loss
  _stateDirty = true;
  // Debounce the Firestore write: collapse rapid saves into one write
  if (_cloudSaveTimer) clearTimeout(_cloudSaveTimer);
  _cloudSaveTimer = setTimeout(() => {
    cloudSaveState();
    _cloudSaveTimer = null;
  }, 5000);
}

function saveStateLocal() {
  try { localStorage.setItem('bloom_state', JSON.stringify(state)); } catch(e){}
}

function loadState() {
  return loadStateLocal();
}

function loadStateLocal() {
  try {
    const saved = localStorage.getItem('bloom_state');
    if (saved) {
      const parsed = JSON.parse(saved);
      Object.assign(state, parsed);
      return true;
    }
  } catch(e){}
  return false;
}

function getDefaultCycle() {
  return {
    lastPeriodStart: null,
    phaseLengths: { ...DEFAULT_PHASE_LENGTHS },
    cycleLength: 28, periodHistory: [], confidence: 0.4,
    healthKitLinked: false,
    symptomWeights: {
      cramps:    { menstrual:0.9, follicular:0.1, ovulatory:0.1, luteal:0.2 },
      bloated:   { menstrual:0.7, follicular:0.1, ovulatory:0.1, luteal:0.6 },
      tired:     { menstrual:0.7, follicular:0.2, ovulatory:0.1, luteal:0.6 },
      headache:  { menstrual:0.5, follicular:0.1, ovulatory:0.2, luteal:0.5 },
      stressed:  { menstrual:0.3, follicular:0.2, ovulatory:0.1, luteal:0.7 },
      motivated: { menstrual:0.1, follicular:0.7, ovulatory:0.9, luteal:0.2 },
      great:     { menstrual:0.1, follicular:0.6, ovulatory:0.9, luteal:0.2 },
      sore:      { menstrual:0.2, follicular:0.3, ovulatory:0.5, luteal:0.3 },
    },
  };
}

function showLoginFromOnboarding() {
  document.getElementById('screen-onboarding').classList.remove('active');
  document.getElementById('screen-auth').classList.add('active');
}

// ═══════════════════════════════════════════
// ONBOARDING JS
// ═══════════════════════════════════════════
let daysUntilNextPeriod = null;
let obPeriodSymptoms = [];

// ── Navigation ──
function obNext(step) {
  // Collect name on step 2 → 3
  if (step === 3) {
    const n = document.getElementById('name-input').value.trim();
    if (n) state.name = n;
  }
  // Populate SVG pet illustrations when reaching the pet picker step
  if (step === 10) {
    document.querySelectorAll('.pet-pick-btn[data-pet-type]').forEach(btn => {
      const d = btn.querySelector('.ppb-emoji');
      if (d) d.innerHTML = getPetSVG(btn.dataset.petType, 100);
    });
  }
  // Hide all steps and clear any leftover inline animation overrides
  document.querySelectorAll('.ob-step').forEach(s => {
    s.classList.add('ob-step-hidden');
    s.style.animation = '';
  });
  const el = document.getElementById('ob-step-' + step);
  if (!el) return;
  el.classList.remove('ob-step-hidden');
  // Force animation restart (transition from display:none resets the keyframe)
  void el.offsetWidth;
  // Scroll the step and the screen to the top
  el.scrollTop = 0;
  const screen = document.getElementById('screen-onboarding');
  if (screen) screen.scrollTop = 0;
}

function obValidateName() {
  const v = document.getElementById('name-input').value.trim();
  const btn = document.getElementById('ob-name-btn');
  if (btn) { btn.disabled = !v; btn.style.opacity = v ? '1' : '.5'; }
}

// ── Step 3: Primary goal (single-select) ──
function selectPrimaryGoal(el, goal) {
  document.querySelectorAll('#primary-goal-grid .choice-btn').forEach(b => b.classList.remove('selected'));
  el.classList.add('selected');
  state.goals = [goal];
  const btn = document.getElementById('ob-goal-btn');
  if (btn) { btn.disabled = false; btn.style.opacity = '1'; btn.textContent = 'Continue →'; }
}

// ── Step 4: Focus muscles (multi-select, max 3) ──
function toggleMuscle(el, muscle) {
  const selected = document.querySelectorAll('#muscle-grid .muscle-btn.selected');
  if (!el.classList.contains('selected') && selected.length >= 3) {
    showToast('💕 Pick up to 3 focus areas');
    return;
  }
  el.classList.toggle('selected');
  const all = [...document.querySelectorAll('#muscle-grid .muscle-btn.selected')].map(b => {
    return b.dataset.muscle;
  }).filter(Boolean);
  state.focusMuscles = all;
}

// ── Step 5: Days + Duration ──
function selectDays(el, n) {
  if (![2, 3, 4, 5].includes(n)) return;
  document.querySelectorAll('.day-pick-btn').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
  state.trainingDaysPerWeek = n;
  const notes = {
    2: 'Perfect for recovery-focused training. Bloom adds extra rest on hard phases. 🍃',
    3: 'Bloom may suggest fewer days in your menstrual and luteal phases. 🌸',
    4: 'Bloom will programme smart splits across your cycle. Luteal weeks may drop to 3. 💜',
    5: 'Ambitious — Bloom will protect recovery days in your menstrual phase no matter what. ⚡️',
  };
  const noteEl = document.getElementById('ob-days-note');
  if (noteEl) noteEl.textContent = notes[n] || '';
}

function selectDuration(el, mins) {
  if (![30, 45, 60, 75].includes(mins)) return;
  document.querySelectorAll('.dur-btn').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
  state.sessionDurationMins = mins;
}

// ── Step 6: Experience ──
function selectXP(el, level) {
  document.querySelectorAll('.xp-card').forEach(c => c.classList.remove('selected'));
  el.classList.add('selected');
  state.level = { beginner:1, intermediate:2, advanced:3 }[level] || 1;
  const btn = document.getElementById('ob-xp-btn');
  if (btn) { btn.disabled = false; btn.style.opacity = '1'; btn.textContent = 'Continue →'; }
}

// ── Step 7: Cycle regularity ──
function selectRegularity(el, type, cycleLen) {
  document.querySelectorAll('#regularity-opts .cycle-opt').forEach(o => o.classList.remove('selected'));
  el.classList.add('selected');
  state.cycle.regularityType = type;
  // Set starting confidence based on how well they know their cycle
  const confidenceMap = { very_regular: 0.65, mostly_regular: 0.5, irregular: 0.3, unknown: 0.2 };
  state.cycle.confidence = confidenceMap[type] || 0.35;
  state.cycle.cycleLength = cycleLen;
  const btn = document.getElementById('ob-reg-btn');
  if (btn) { btn.disabled = false; btn.style.opacity = '1'; btn.textContent = 'Continue →'; }
}

// ── Step 8: Cycle + period length ──
function selectCycleLength(el, days) {
  document.querySelectorAll('#cycle-length-picker .cl-btn').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
  const clamped = Math.min(50, Math.max(20, parseInt(days, 10) || 28));
  state.cycle.cycleLength = clamped;
  // Recalculate phase lengths from cycle length
  const bleed = state.cycle.phaseLengths.menstrual;
  const ovu = 3;
  const fol = Math.max(5, Math.round((state.cycle.cycleLength - bleed - ovu) * 0.45));
  const lut = Math.max(7, state.cycle.cycleLength - bleed - fol - ovu);
  state.cycle.phaseLengths = { menstrual: bleed, follicular: fol, ovulatory: ovu, luteal: lut };
}

function selectPeriodDays(el, days) {
  document.querySelectorAll('#period-days-picker .cl-btn').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
  state.cycle.phaseLengths.menstrual = days;
  // Recalculate follicular + luteal after menstrual change
  const bleed = days;
  const ovu = 3;
  const fol = Math.max(5, Math.round((state.cycle.cycleLength - bleed - ovu) * 0.45));
  const lut = Math.max(7, state.cycle.cycleLength - bleed - fol - ovu);
  state.cycle.phaseLengths = { menstrual: bleed, follicular: fol, ovulatory: ovu, luteal: lut };
}

// ── Step 9: Next period + symptoms ──
function setNextPeriodDays(val) {
  const n = parseInt(val, 10);
  daysUntilNextPeriod = (!isNaN(n) && n >= 1 && n <= 90) ? n : null;
}

function selectCycleDay(el, daysAgo) {
  document.querySelectorAll('#cycle-opts .cycle-opt').forEach(o => o.classList.remove('selected'));
  el.classList.add('selected');
}

function toggleObSymptom(el, sym) {
  el.classList.toggle('selected');
  if (obPeriodSymptoms.includes(sym)) obPeriodSymptoms = obPeriodSymptoms.filter(s => s !== sym);
  else obPeriodSymptoms.push(sym);
}

// ── Finish ──
function finishOnboarding() {
  // Apply symptom priors from the period symptoms they reported
  obPeriodSymptoms.forEach(sym => {
    if (!state.cycle.symptomWeights[sym]) {
      state.cycle.symptomWeights[sym] = { menstrual:0.5, follicular:0.2, ovulatory:0.1, luteal:0.3 };
    }
    // Strongly associate these symptoms with menstrual phase
    state.cycle.symptomWeights[sym].menstrual = Math.min(0.92,
      (state.cycle.symptomWeights[sym].menstrual || 0.5) + 0.2
    );
  });

  // Seed cycle model from next period date
  if (daysUntilNextPeriod !== null) {
    const cycleLen = state.cycle.cycleLength || 28;
    const daysAgo = Math.max(0, cycleLen - daysUntilNextPeriod);
    const lastPeriodDate = new Date();
    lastPeriodDate.setDate(lastPeriodDate.getDate() - daysAgo);
    const dateStr = lastPeriodDate.toISOString().split('T')[0];
    state.cycle.lastPeriodStart = dateStr;
    state.cycle.periodHistory = [dateStr];
  }

  // Apply training preferences to SESSION_TYPES duration scaling
  if (state.sessionDurationMins) {
    // Scale all session durations relative to chosen preference
    // 45min = 1.0× baseline, 30=0.67, 60=1.33, 75=1.67
    state.durationScale = state.sessionDurationMins / 45;
  }
  if (!state.trainingDaysPerWeek) state.trainingDaysPerWeek = 3;
  if (!state.focusMuscles) state.focusMuscles = [];

  // Boost confidence from period symptoms reported (more data = better baseline)
  if (obPeriodSymptoms.length >= 2) {
    state.cycle.confidence = Math.min(0.85, state.cycle.confidence + 0.1);
  }

  // Initialise pet companion chosen in step 10
  if (_selectedPet) {
    state.pet = {
      type: _selectedPet,
      health: 100,
      lastFedDate: new Date().toISOString().split('T')[0],
      totalFeeds: 0,
    };
    _selectedPet = null;
  }

  advanceCycleDay();
  invalidateML();
  saveState();

  onboardingCompleted = true;
  localStorage.setItem('bloom_onboarding_done', '1');

  document.getElementById('screen-onboarding').classList.remove('active');

  // If Firebase is unavailable (offline mode), skip auth and go straight to the app
  if (window._firebaseFailed) {
    document.getElementById('bottom-nav').style.display = 'flex';
    goTo('today');
  } else {
    document.getElementById('bottom-nav').style.display = 'none';
    document.getElementById('screen-auth').classList.add('active');
  }
}

// Legacy - kept for any remaining references
function updateLevel(val) {
  const n = parseInt(val, 10);
  if (!isNaN(n)) state.level = Math.min(3, Math.max(1, n));
}
function toggleGoal(el, goal) {
  el.classList.toggle('selected');
  if (!state.goals.includes(goal)) state.goals.push(goal);
  else state.goals = state.goals.filter(g => g !== goal);
}

// ═══════════════════════════════════════════
// PROGRESS PHOTOS
// ═══════════════════════════════════════════
let _pendingPhotos = []; // base64 strings waiting to be saved

function getProgressPhotos() {
  try {
    return JSON.parse(localStorage.getItem('bloomProgressPhotos') || '[]');
  } catch (e) { return []; }
}

function saveProgressPhotosData(photos) {
  localStorage.setItem('bloomProgressPhotos', JSON.stringify(photos));
}

// Wire up file input
document.addEventListener('DOMContentLoaded', () => {
  const fileInput = document.getElementById('photo-file-input');
  if (fileInput) {
    fileInput.addEventListener('change', handlePhotoFiles);
  }
});

const ALLOWED_PHOTO_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'image/gif']);
const MAX_PHOTO_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

function handlePhotoFiles(e) {
  const rawFiles = Array.from(e.target.files);
  if (!rawFiles.length) return;

  const files = rawFiles.filter(file => {
    if (!ALLOWED_PHOTO_TYPES.has(file.type)) {
      showToast(`\u26a0\ufe0f ${file.name}: unsupported type — use JPG, PNG or WebP`);
      return false;
    }
    if (file.size > MAX_PHOTO_SIZE_BYTES) {
      showToast(`\u26a0\ufe0f ${file.name}: too large (max 10 MB)`);
      return false;
    }
    return true;
  });

  if (!files.length) { e.target.value = ''; return; }

  _pendingPhotos = [];
  const strip = document.getElementById('photos-preview-strip');
  strip.innerHTML = '';

  let settled = 0;
  const total = files.length;

  const maybeShowForm = () => {
    if (settled === total && _pendingPhotos.length > 0) {
      document.getElementById('photos-form').style.display = 'block';
      document.getElementById('photo-date-input').value = new Date().toISOString().split('T')[0];
      document.getElementById('photo-caption-input').value = '';
    }
  };

  files.forEach(file => {
    const reader = new FileReader();
    reader.onload = (ev) => {
      _pendingPhotos.push(ev.target.result);
      const img = document.createElement('img');
      img.src = ev.target.result;
      img.className = 'photos-preview-thumb';
      strip.appendChild(img);
      settled++;
      maybeShowForm();
    };
    reader.onerror = () => {
      settled++;
      showToast(`\u26a0\ufe0f Could not read ${file.name}`);
      maybeShowForm();
    };
    reader.readAsDataURL(file);
  });
  // Reset input so same file can be re-selected
  e.target.value = '';
}

function cancelPhotoUpload() {
  _pendingPhotos = [];
  document.getElementById('photos-form').style.display = 'none';
  document.getElementById('photos-preview-strip').innerHTML = '';
}

function saveProgressPhotos() {
  if (!_pendingPhotos.length) return;
  const date = document.getElementById('photo-date-input').value || new Date().toISOString().split('T')[0];
  const caption = document.getElementById('photo-caption-input').value.trim();
  const photos = getProgressPhotos();

  _pendingPhotos.forEach(dataUrl => {
    photos.push({
      id: (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : (Date.now() + '_' + Math.random().toString(36).slice(2, 9)),
      src: dataUrl,
      date: date,
      caption: caption,
      createdAt: Date.now()
    });
  });

  try {
    saveProgressPhotosData(photos);
  } catch (e) {
    // localStorage quota exceeded
    showToast('⚠️ Storage full — try smaller photos');
    return;
  }

  _pendingPhotos = [];
  document.getElementById('photos-form').style.display = 'none';
  document.getElementById('photos-preview-strip').innerHTML = '';
  showToast('📸 Photos saved!');
  renderPhotosGallery();
}

function deleteProgressPhoto(id) {
  const photos = getProgressPhotos().filter(p => p.id !== id);
  saveProgressPhotosData(photos);
  showToast('🗑️ Photo removed');
  renderPhotosGallery();
}

function renderPhotosGallery() {
  const photos = getProgressPhotos();
  const gallery = document.getElementById('photos-gallery');
  const empty = document.getElementById('photos-empty');
  gallery.innerHTML = '';

  if (!photos.length) {
    empty.style.display = 'block';
    gallery.style.display = 'none';
    return;
  }

  empty.style.display = 'none';
  gallery.style.display = 'grid';

  // Sort oldest first (progress view)
  const sorted = [...photos].sort((a, b) => new Date(a.date) - new Date(b.date));

  sorted.forEach((photo, i) => {
    const card = document.createElement('div');
    card.className = 'photo-card';
    card.style.animationDelay = (i * 0.06) + 's';

    const img = document.createElement('img');
    img.className = 'photo-card-img';
    img.src = photo.src;
    img.alt = 'Progress photo';
    img.addEventListener('click', () => openLightbox(photo.id));

    const info = document.createElement('div');
    info.className = 'photo-card-info';

    const dateDiv = document.createElement('div');
    dateDiv.className = 'photo-card-date';
    dateDiv.textContent = formatPhotoDate(photo.date);
    info.appendChild(dateDiv);

    if (photo.caption) {
      const capDiv = document.createElement('div');
      capDiv.className = 'photo-card-caption';
      capDiv.textContent = photo.caption;
      info.appendChild(capDiv);
    }

    const delBtn = document.createElement('button');
    delBtn.className = 'photo-card-delete';
    delBtn.textContent = '🗑️ Delete';
    delBtn.addEventListener('click', () => deleteProgressPhoto(photo.id));

    card.appendChild(img);
    card.appendChild(info);
    card.appendChild(delBtn);
    gallery.appendChild(card);
  });
}

function formatPhotoDate(dateStr) {
  if (!dateStr) return 'Unknown date';
  const d = new Date(dateStr + 'T00:00:00');
  if (isNaN(d.getTime())) return 'Unknown date';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function openLightbox(photoId) {
  const photos = getProgressPhotos();
  const photo = photos.find(p => p.id === photoId);
  if (!photo) return;
  document.getElementById('lightbox-img').src = photo.src;
  const caption = photo.caption
    ? `${formatPhotoDate(photo.date)} · ${escapeHtml(photo.caption)}`
    : formatPhotoDate(photo.date);
  document.getElementById('lightbox-caption').textContent = caption;
  document.getElementById('photo-lightbox').classList.add('open');
}

function closeLightbox(e) {
  if (e && e.target !== e.currentTarget && !e.target.classList.contains('lightbox-close')) return;
  document.getElementById('photo-lightbox').classList.remove('open');
}

// ═══════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════
function init() {
  // Status bar removed for premium web layout

  if (!state.cycle) state.cycle = getDefaultCycle();

  // Hide nav and all screens — Firebase module will show the right one
  document.getElementById('bottom-nav').style.display = 'none';
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));

  // Show onboarding first; after completion, show auth screen
  // If user already completed onboarding (returning visitor), show auth directly
  // _onAuthStateChanged will skip to today if already logged in
  if (onboardingCompleted) {
    document.getElementById('screen-auth').classList.add('active');
  } else {
    document.getElementById('screen-onboarding').classList.add('active');
  }

  // Fallback: if Firebase module fails to load (network issue, etc.) go offline
  window._onFirebaseFailed = () => {
    console.warn('Bloom: Firebase unavailable — offline mode');
    offlineInit();
  };

  // Safety net: if Firebase hasn't called back within 8 seconds, go offline
  setTimeout(() => {
    if (!window._firebaseCallbackReceived) {
      console.warn('Bloom: Firebase timeout — offline mode');
      offlineInit();
    }
  }, 8000);
}

init();
