import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm'
import { SUPABASE_URL, SUPABASE_KEY, VAPID_PUBLIC_KEY } from './config.js'

const sb = createClient(SUPABASE_URL, SUPABASE_KEY)

// ---------- dátumy (lokálny čas zariadenia = Slovensko) ----------
const pad = n => String(n).padStart(2, '0')
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const dt = s => new Date(s + 'T00:00')
const add = (s, n) => { const d = dt(s); d.setDate(d.getDate() + n); return iso(d) }
const work = s => { const w = dt(s).getDay(); return w > 0 && w < 6 }
const nextWork = s => { do s = add(s, 1); while (!work(s)); return s }
const days = (a, b) => { const r = []; for (let s = a; s <= b; s = add(s, 1)) if (work(s)) r.push(s); return r }
const DN = ['Ne', 'Po', 'Ut', 'St', 'Št', 'Pi', 'So']
const sk = s => { const d = dt(s); return `${DN[d.getDay()]} ${d.getDate()}. ${d.getMonth() + 1}.` }
const time = ts => new Date(ts).toLocaleString('sk', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' })
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const DEADLINE = 8 // školský poriadok: strava do 8:00 v deň neprítomnosti (server to kontroluje sám v triggeri)
const mealOpen = s => { const d = dt(s); d.setHours(DEADLINE); return new Date() < d }
const TODAY = iso(new Date())
const NEXT = work(TODAY) && mealOpen(TODAY) ? TODAY : nextWork(TODAY)
const KITCHEN_DAY = work(TODAY) ? TODAY : nextWork(TODAY)
const MON = (() => { let s = TODAY; while (dt(s).getDay() != 1) s = add(s, -1); return s })()
const first = n => String(n).split(' ')[0]

const ROLE = { parent: 'Rodič', teacher: 'Učiteľka', admin: 'Vedenie', kitchen: 'Kuchyňa' }
const DEF = { parent: 'board', teacher: 'class', admin: 'over', kitchen: 'kitchen' }
const TYPES = { oznam: 'Oznam', prineste: 'Prineste', anketa: 'Anketa', udalost: 'Udalosť' }
const REASONS = ['Choroba', 'Rodinné dôvody', 'Dovolenka', 'Návšteva lekára', 'Iné']

const S = { me: null, role: null, v: null, d: {}, filter: 'all', form: null, draft: null, thread: null, week: 0, reg: false, push: false }

// ---------- dáta ----------
const q = async p => { const { data, error } = await p; if (error) throw error; return data }
async function load() {
  const r = S.role, D = S.d
  Object.assign(D, Object.fromEntries(await Promise.all(Object.entries({
    classes: sb.from('classes').select('*').order('sort'),
    ct: sb.from('class_teachers').select('*'),
    profiles: sb.from('profiles').select('id, full_name, email, role, approved, requested_child'),
    posts: sb.from('posts').select('*').order('created_at', { ascending: false }).limit(100),
    reads: sb.from('post_reads').select('post_id, user_id'),
    votes: sb.from('poll_votes').select('post_id, user_id, choice'),
    menu: sb.from('menu').select('*').gte('day', MON).lte('day', add(MON, 11)),
  }).map(async ([k, p]) => [k, await q(p)]))))
  if (r == 'kitchen' || r == 'admin') D.meals = await q(sb.rpc('meal_counts', { d: KITCHEN_DAY }))
  if (r == 'kitchen') return
  const month = TODAY.slice(0, 8) + '01'
  Object.assign(D, Object.fromEntries(await Promise.all(Object.entries({
    children: sb.from('children').select('*').eq('active', true).order('name'),
    guardians: sb.from('guardians').select('*'),
    absences: sb.from('absences').select('*').gte('date_to', month).order('date_from'),
    attendance: sb.from('attendance').select('*').gte('day', month),
    pickups: sb.from('pickups').select('*').order('created_at'),
    consents: sb.from('consents').select('*'),
    msgs: sb.from('messages').select('*').order('created_at', { ascending: false }).limit(300),
    staff: r == 'parent' ? Promise.resolve({ data: [] }) : sb.from('staff_absences').select('*').gte('day', MON).lte('day', add(MON, 4)),
  }).map(async ([k, p]) => [k, await q(p)]))))
  S.child ??= D.children[0]?.id
  S.cls ??= D.ct.find(x => x.teacher_id == S.me.id)?.class_id ?? D.classes[0]?.id
}

// ---------- vyhľadávanie ----------
const byId = (a, id) => a?.find(x => x.id == id)
const pname = id => byId(S.d.profiles, id)?.full_name || 'Rodič'
const cls = id => byId(S.d.classes, id) ?? { name: '–' }
const kidsIn = c => S.d.children.filter(k => k.class_id == c)
const teachersOf = c => S.d.ct.filter(x => x.class_id == c).map(x => x.teacher_id)
const classOf = t => cls(S.d.ct.find(x => x.teacher_id == t)?.class_id)
const absOn = (k, d) => S.d.absences.find(a => a.child_id == k && a.date_from <= d && a.date_to >= d)
const status = (k, d) => { const a = absOn(k, d); return a ? { s: 'abs', a } : S.d.attendance.some(x => x.child_id == k && x.day == d) ? { s: 'miss' } : { s: 'ok' } }
const myKid = () => byId(S.d.children, S.child)
const parentsIn = c => [...new Set(S.d.guardians.filter(g => { const k = byId(S.d.children, g.child_id); return k && (!c || k.class_id == c) }).map(g => g.parent_id))]
const readBy = p => S.d.reads.filter(r => r.post_id == p.id).map(r => r.user_id)
const teachers = () => S.d.profiles.filter(p => p.role == 'teacher' || p.role == 'admin')

// ---------- UI kúsky ----------
const I = { home: '<path d="M4 10l8-6 8 6v9a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z"/>', cal: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/>', chat: '<path d="M5 5h14a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9l-4 3V6a1 1 0 0 1 1-1z"/>', kid: '<circle cx="12" cy="8" r="4"/><path d="M4 20c1.5-4 4.5-6 8-6s6.5 2 8 6"/>', lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>', ok: '<path d="M5 12l5 5 9-10"/>', group: '<circle cx="9" cy="8" r="3"/><circle cx="17" cy="9" r="2.5"/><path d="M3 19c1-3 3.5-5 6-5s5 2 6 5M15 14.5c2.5 0 4.5 1.5 5.5 4"/>', mega: '<path d="M4 10v4h3l7 5V5L7 10z"/><path d="M18 9a4 4 0 0 1 0 6"/>', back: '<path d="M15 5l-7 7 7 7"/>' }
const ic = n => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${I[n]}</svg>`
const TABS = { parent: [['board', 'Nástenka', 'home'], ['cal', 'Kalendár', 'cal'], ['msg', 'Správy', 'chat'], ['kid', 'Dieťa', 'kid']], teacher: [['class', 'Trieda', 'group'], ['posts', 'Oznamy', 'mega'], ['msg', 'Správy', 'chat'], ['cal', 'Kalendár', 'cal']], admin: [['over', 'Prehľad'], ['users', 'Používatelia'], ['staff', 'Personál'], ['report', 'Výkaz'], ['kitchen', 'Kuchyňa'], ['posts', 'Oznamy']] }
const logo = () => `<div class="row"><img src="icon-192.png" width="36" height="36" alt=""><div><div class="disp" style="font-size:22px">Ďatelinka</div><div class="mute" style="font-size:12px">Materská škola Zvolen</div></div></div>`
const lock = (t, d) => `<div class="lock">${ic('lock')}<div><div class="row" style="gap:8px"><b>${t}</b><span class="gdpr">Podlieha GDPR</span></div><div class="mute" style="margin-top:4px">${d}</div></div></div>`
const adminTabs = () => S.role != 'admin' ? '' : `<div class="row sp" style="flex-wrap:wrap">${logo()}<div class="chips">${TABS.admin.map(([v, l]) => `<button class="chip ${S.v == v ? 'on' : ''}" data-a="go" data-v="${v}">${l}</button>`).join('')}</div></div>`
const kidChips = () => S.d.children.length < 2 ? '' : `<div class="chips">${S.d.children.map(k => `<button class="chip ${k.id == S.child ? 'on' : ''}" data-a="child" data-id="${k.id}">${esc(k.name)}</button>`).join('')}</div>`
const todo = () => [
  ...S.d.staff.filter(x => !x.substitute_id && x.day >= TODAY).map(x => `<div class="banner" style="background:var(--o);color:var(--ot)"><b>${sk(x.day)}:</b> za ${esc(pname(x.teacher_id))} (${esc(classOf(x.teacher_id).name)}) chýba záskok</div>`),
  ...S.d.children.filter(k => status(k.id, TODAY).s == 'miss').map(k => `<div class="banner" style="background:var(--lock)">Neohlásená neprítomnosť: <b>${esc(k.name)}</b> (${esc(cls(k.class_id).name)})</div>`)
].join('') || '<span class="mute">Všetko v poriadku.</span>'

function post(p) {
  const scope = p.class_id ? cls(p.class_id).name : 'Celá MŠ'
  let body = p.body ? `<div style="white-space:pre-line;line-height:1.45">${esc(p.body)}</div>` : ''
  if (p.event_date) body += `<div class="mute">${p.type == 'prineste' ? 'Do' : 'Kedy'}: <b>${sk(p.event_date)}</b></div>`
  if (p.poll_options) {
    const vs = S.d.votes.filter(v => v.post_id == p.id), tot = vs.length || 1, voted = vs.some(v => v.user_id == S.me.id) || S.role != 'parent'
    body += p.poll_options.map((o, i) => { const n = vs.filter(v => v.choice == i).length
      return voted ? `<div class="bar"><i style="width:${n / tot * 100}%"></i><span><span>${esc(o)}</span><span>${n}</span></span></div>`
        : `<button class="chip" style="border-radius:10px;min-height:44px;text-align:left" data-a="vote" data-id="${p.id}" data-i="${i}">${esc(o)}</button>` }).join('')
  }
  const ack = !p.require_read || S.role != 'parent' ? '' : readBy(p).includes(S.me.id) ? `<span class="row" style="gap:4px;color:var(--g);font-weight:700;font-size:14px">${ic('ok')}Potvrdené</span>` : `<button class="btn out" data-a="confirm" data-id="${p.id}">Beriem na vedomie</button>`
  return `<article class="card" ${p.type == 'prineste' ? 'style="background:var(--y);border-color:#EFDFA8"' : ''}>
  <div class="row" style="gap:6px"><span class="pill ${p.type == 'prineste' ? 'o' : 'g'}">${TYPES[p.type]} · ${esc(scope)}</span>${p.pinned ? '<span class="pill">Pripnuté</span>' : ''}</div>
  <div style="font-size:17px;font-weight:700">${esc(p.title)}</div>${body}
  <div class="row sp"><span class="mute">${esc(pname(p.author_id))} · ${sk(p.created_at.slice(0, 10))}</span>${ack}</div></article>`
}

// ---------- obrazovky ----------
const V = {}
V.login = () => `<div style="margin-top:10vh">${logo()}</div>${S.reg
  ? `<form class="card" data-a="register"><h2 style="font-size:20px">Registrácia rodiča</h2>
     <label class="f">Vaše meno a priezvisko<input name="name" autocomplete="name" required></label>
     <label class="f">Meno dieťaťa<input name="child" required placeholder="napr. Ema Kováčová"></label>
     <label class="f">E-mail<input name="email" type="email" autocomplete="email" required></label>
     <label class="f">Heslo (aspoň 8 znakov)<input name="password" type="password" autocomplete="new-password" minlength="8" required></label>
     <button class="btn">Zaregistrovať sa</button><div class="mute">Účet schváli riaditeľka a priradí vám dieťa. Dovtedy v platforme nič neuvidíte.</div>
     <button type="button" class="btn ghost" data-a="mode">Už mám účet</button></form>`
  : `<form class="card" data-a="login"><label class="f">E-mail<input name="email" type="email" autocomplete="email" required></label>
     <label class="f">Heslo<input name="password" type="password" autocomplete="current-password" required></label>
     <button class="btn">Prihlásiť sa</button><button type="button" class="btn ghost" data-a="mode">Nemám účet – registrácia</button></form>`}`

V.pending = () => `${logo()}<div class="card"><h2 style="font-size:20px">Účet čaká na schválenie</h2><div>Riaditeľka skontroluje registráciu a priradí vám dieťa${S.me.requested_child ? ` (<b>${esc(S.me.requested_child)}</b>)` : ''}. Potom sa vám platforma sprístupní.</div><button class="btn out" data-a="recheck">Skontrolovať znova</button></div>`

// Párovanie registrácie s dieťaťom: zhoda aspoň jedného slova (bez diakritiky, 3+ znaky).
const norm = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
const matches = (req, name) => { const w = norm(name).split(/\s+/); return norm(req).split(/\s+/).some(x => x.length >= 3 && w.some(y => y.startsWith(x) || x.startsWith(y) && y.length >= 3)) }

V.users = () => {
  const pending = S.d.profiles.filter(p => !p.approved)
  return adminTabs() + `<h1 style="font-size:28px">Používatelia</h1>
 <div class="lbl">Čakajú na schválenie (${pending.length})</div>
 ${pending.map(p => { const hit = S.d.children.filter(k => p.requested_child && matches(p.requested_child, k.name))
    return `<form class="card" data-a="approve" data-id="${p.id}"><div class="row sp" style="flex-wrap:wrap"><div><b>${esc(p.full_name || '–')}</b> <span class="mute">${esc(p.email)}</span></div><span class="pill ${hit.length ? 'g' : 'o'}">${hit.length ? `zhoda: ${hit.length}` : 'bez zhody'}</span></div>
   <div>Uvedené dieťa: <b>${esc(p.requested_child || '–')}</b></div>
   <div class="f">Priradiť k dieťaťu<div class="chips">${S.d.children.map(k => `<label class="chip ${hit.includes(k) ? 'on' : ''}"><input type="checkbox" name="child" value="${k.id}" ${hit.includes(k) ? 'checked' : ''} style="width:16px;height:16px;margin-right:6px;vertical-align:-2px">${esc(k.name)} <span class="mute">${esc(cls(k.class_id).name)}</span></label>`).join('') || '<span class="mute">Najprv pridajte deti nižšie.</span>'}</div></div>
   <label class="f" style="max-width:240px">Rola<select name="role">${Object.entries(ROLE).map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></label>
   <button class="btn" style="align-self:flex-start">Schváliť</button></form>` }).join('') || '<p class="mute">Nikto nečaká.</p>'}
 <div class="lbl">Deti</div>
 <form class="card row" data-a="addChild" style="flex-direction:row;flex-wrap:wrap;align-items:flex-end"><label class="f grow">Meno dieťaťa<input name="name" required></label><label class="f">Trieda<select name="cls">${S.d.classes.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></label><button class="btn">Pridať dieťa</button></form>
 <div class="card" style="overflow-x:auto"><table><tr><th>Dieťa</th><th>Trieda</th><th>Rodičia</th></tr>${S.d.children.map(k => `<tr><td>${esc(k.name)}</td><td>${esc(cls(k.class_id).name)}</td><td>${S.d.guardians.filter(g => g.child_id == k.id).map(g => esc(pname(g.parent_id))).join(', ') || '<span class="mute">nikto</span>'}</td></tr>`).join('')}</table></div>`
}

V.board = () => {
  const k = myKid()
  if (!k) return `${logo()}<div class="card">Zatiaľ nemáte priradené dieťa. Ozvite sa, prosím, v škôlke.</div>`
  const ps = S.d.posts.filter(p => (!p.class_id || p.class_id == k.class_id) && (S.filter == 'all' || (S.filter == 'cls') == (p.class_id == k.class_id))).sort((a, b) => (b.pinned - a.pinned) || (b.id - a.id))
  return `${logo()}${kidChips()}
 <section class="card row" style="flex-direction:row;background:var(--g);color:#fff;border:0">
  <div class="grow"><h2 style="font-size:19px;font-weight:600">${esc(first(k.name))} nepríde?</h2><div style="font-size:13px;color:#DCEBD8;margin-top:4px">Stravu na ${sk(NEXT)} odhlásite do ${DEADLINE}:00 v ten deň. Príchod do 8:00, potom sa budova zamyká.</div></div>
  <button class="btn" style="background:#fff;color:var(--g)" data-a="go" data-v="absence">Odhlásiť</button></section>
 <div class="row sp"><h2 style="font-size:20px;font-weight:600">Nástenka</h2><div class="chips">${[['all', 'Všetko'], ['cls', cls(k.class_id).name], ['school', 'Celá MŠ']].map(([f, l]) => `<button class="chip ${S.filter == f ? 'on' : ''}" data-a="filter" data-f="${f}">${esc(l)}</button>`).join('')}</div></div>
 ${ps.map(post).join('') || '<p class="mute">Zatiaľ nič.</p>'}`
}

V.absence = () => {
  const k = myKid()
  S.form ??= { from: NEXT, to: NEXT, r: 'Choroba', note: '' }
  const f = S.form, ds = days(f.from, f.to), late = ds.filter(d => !mealOpen(d)).length, cal = (dt(f.to) - dt(f.from)) / 864e5 + 1
  const mine = S.d.absences.filter(a => a.child_id == k.id && a.date_to >= TODAY)
  return `<header class="row"><button class="btn ghost" aria-label="Späť" data-a="go" data-v="board">${ic('back')}</button><div><h1 style="font-size:22px">Odhlásiť dieťa</h1><div class="mute">${esc(k.name)} · ${esc(cls(k.class_id).name)}</div></div></header>
 <div class="banner" style="background:var(--o);color:var(--ot)"><b>Uzávierka:</b> strava sa odhlasuje najneskôr do ${DEADLINE}:00 v deň neprítomnosti. Potom sa platí v plnej výške.</div>
 <div class="grid2"><label class="f">Od<input type="date" data-c="from" min="${TODAY}" value="${f.from}"></label><label class="f">Do (vrátane)<input type="date" data-c="to" min="${f.from}" value="${f.to}"></label></div>
 <div class="f">Dôvod<div class="chips">${REASONS.map(r => `<button class="chip ${f.r == r ? 'on' : ''}" data-a="reason" data-r="${r}">${r}</button>`).join('')}</div></div>
 <label class="f">Poznámka pre učiteľku (nepovinné)<textarea rows="2" data-c="note">${esc(f.note)}</textarea></label>
 <div class="card"><div class="row sp"><span class="mute">Pracovné dni</span><b>${ds.length}</b></div><div class="row sp"><span class="mute">Strava</span><b style="color:${late ? 'var(--ot)' : 'var(--g)'}">${!ds.length ? '–' : late ? `${ds.length - late} dní odhlásených, ${late} po uzávierke` : 'odhlási sa automaticky'}</b></div></div>
 ${cal > 7 ? '<div class="banner" style="background:var(--b);color:var(--bt)">Neprítomnosť nad 7 dní: pri návrate treba <b>potvrdenie od lekára</b>.</div>' : cal >= 5 ? '<div class="banner" style="background:var(--b);color:var(--bt)">Po 5 a viac dňoch neprítomnosti treba pri návrate <b>vyhlásenie o bezinfekčnosti</b>.</div>' : ''}
 <button class="btn" data-a="submitAbs" ${ds.length ? '' : 'disabled'}>Odhlásiť ${esc(first(k.name))}</button>
 ${mine.length ? `<div class="lbl">Aktuálne odhlásenia</div>` + mine.map(a => `<div class="card row" style="flex-direction:row"><div class="grow"><b>${sk(a.date_from)}${a.date_to != a.date_from ? ' – ' + sk(a.date_to) : ''}</b> · ${esc(a.reason)}<div class="mute">${a.meals_from ? 'strava odhlásená od ' + sk(a.meals_from) : 'strava po uzávierke'}</div></div>${a.date_from > TODAY || (a.date_from == TODAY && mealOpen(TODAY)) ? `<button class="btn ghost" data-a="cancelAbs" data-id="${a.id}">Zrušiť</button>` : ''}</div>`).join('') : ''}`
}

V.cal = () => {
  const c = S.role == 'parent' ? myKid()?.class_id : S.cls, m = S.d.menu.find(x => x.day == NEXT)
  const ev = S.d.posts.filter(p => p.event_date >= TODAY && (p.type == 'udalost' || p.type == 'prineste') && (!p.class_id || p.class_id == c)).sort((a, b) => a.event_date < b.event_date ? -1 : 1)
  return `<h1 style="font-size:26px">Kalendár</h1>${ev.map(e => `<div class="card row" style="flex-direction:row;gap:14px"><div style="width:56px;text-align:center"><div class="mute">${DN[dt(e.event_date).getDay()]}</div><div class="disp" style="font-size:18px">${dt(e.event_date).getDate()}. ${dt(e.event_date).getMonth() + 1}.</div></div><div><b>${esc(e.title)}</b><div class="mute">${TYPES[e.type]} · ${e.class_id ? esc(cls(e.class_id).name) : 'Celá MŠ'}</div></div></div>`).join('') || '<p class="mute">Žiadne udalosti.</p>'}
 <h2 style="font-size:20px;font-weight:600">Jedálniček · ${sk(NEXT)}</h2>${m ? `<div class="card list" style="padding-block:4px">${[['Desiata', m.snack], ['Obed', m.lunch], ['Olovrant', m.afternoon]].map(([l, x]) => `<div class="row"><b class="mute" style="width:78px">${l}</b><span class="grow">${esc(x)}</span></div>`).join('')}</div><div class="mute">Čísla = alergény (1–14).</div>` : '<p class="mute">Jedálniček ešte nie je zverejnený.</p>'}`
}

V.msg = () => {
  const staff = S.role != 'parent'
  if (staff && !S.thread) {
    const ks = kidsIn(S.cls).map(k => ({ k, last: S.d.msgs.find(m => m.child_id == k.id) })).sort((a, b) => (b.last?.created_at ?? '').localeCompare(a.last?.created_at ?? ''))
    return `<h1 style="font-size:24px">Správy · ${esc(cls(S.cls).name)}</h1><div class="card list" style="padding-block:4px">${ks.map(({ k, last }) => `<div><button class="btn ghost" style="width:100%;text-align:left;color:var(--ink)" data-a="thread" data-id="${k.id}"><b>${esc(k.name)}</b><div class="mute">${last ? esc(last.body.slice(0, 60)) + ' · ' + time(last.created_at) : 'bez správ'}</div></button></div>`).join('') || '<div class="mute">V triede nie sú deti.</div>'}</div>`
  }
  const k = byId(S.d.children, staff ? S.thread : S.child)
  if (!k) return '<p class="mute">Nemáte priradené dieťa.</p>'
  const h = new Date().getHours() + new Date().getMinutes() / 60, quiet = h < 6.5 || h >= 17
  const ms = S.d.msgs.filter(m => m.child_id == k.id).reverse()
  return `<header class="row">${staff ? `<button class="btn ghost" aria-label="Späť" data-a="thread" data-id="">${ic('back')}</button>` : ''}<div><h1 style="font-size:20px">${staff ? esc(k.name) : 'Trieda ' + esc(cls(k.class_id).name)}</h1><div class="mute">${staff ? 'rodičia' : teachersOf(k.class_id).map(pname).map(esc).join(', ')}</div></div></header>
 ${!staff ? kidChips() : ''}${!staff && quiet ? '<div class="banner" style="background:var(--lock)">Mimo prevádzky (6:30–17:00) učiteľka správu uvidí ráno. Stravu odhlasujte tlačidlom Odhlásiť, nie správou.</div>' : ''}
 <div style="display:flex;flex-direction:column;gap:8px">${ms.map(m => `<div class="msg ${m.sender_id == S.me.id ? 'me' : 'them'}">${esc(m.body)}<div style="font-size:11px;opacity:.75;margin-top:4px">${m.sender_id == S.me.id ? '' : esc(pname(m.sender_id)) + ' · '}${time(m.created_at)}</div></div>`).join('') || '<p class="mute">Zatiaľ žiadne správy.</p>'}</div>
 <form class="row" data-a="send" data-child="${k.id}"><label class="grow"><span class="sr">Správa</span><input name="t" placeholder="Napíšte správu…" autocomplete="off" required maxlength="2000"></label><button class="btn">Odoslať</button></form>`
}

V.kid = () => {
  const k = myKid()
  if (!k) return '<p class="mute">Nemáte priradené dieťa.</p>'
  const ps = S.d.pickups.filter(p => p.child_id == k.id), trips = S.d.consents.find(c => c.child_id == k.id && c.kind == 'vylety')
  return `${kidChips()}<header class="row"><div style="width:60px;height:60px;border-radius:30px;background:var(--gs);color:var(--g);display:grid;place-items:center;font-weight:700;font-size:20px">${esc(k.name.split(' ').map(x => x[0]).join('').slice(0, 2))}</div><div><h1 style="font-size:24px">${esc(k.name)}</h1><div class="mute">Trieda ${esc(cls(k.class_id).name)} · ${teachersOf(k.class_id).map(pname).map(esc).join(', ')}</div></div></header>
 <div class="card"><div class="lbl">Zákonní zástupcovia</div>${S.d.guardians.filter(g => g.child_id == k.id).map(g => `<div>${g.parent_id == S.me.id ? `<b>${esc(S.me.full_name || S.me.email)}</b> (vy)` : 'ďalší zákonný zástupca'}</div>`).join('')}</div>
 <div class="card"><div class="lbl">Môžu vyzdvihnúť</div>${ps.map(p => `<div class="row"><div class="grow"><b>${esc(p.name)}</b> <span class="mute">${esc(p.relation)}</span><div><span class="pill ${p.authorized ? 'g' : 'o'}">${p.authorized ? 'splnomocnenie odovzdané' : 'chýba písomné splnomocnenie'}</span></div></div><button class="btn ghost" data-a="rmPick" data-id="${p.id}">Odstrániť</button></div>`).join('') || '<span class="mute">Len zákonní zástupcovia.</span>'}
  <div class="mute">Osobu musí potvrdiť písomné splnomocnenie odovzdané v MŠ. Dovtedy ju učiteľka nevidí ako oprávnenú.</div>
  <form class="grid2" data-a="addPick" data-child="${k.id}"><input name="n" aria-label="Meno" placeholder="Meno" required><input name="r" aria-label="Vzťah" placeholder="Vzťah" required><button class="btn out" style="grid-column:span 2">Pridať osobu</button></form></div>
 ${lock('Zdravie a strava', 'Alergie, chronické ochorenia a diéty. Lieky MŠ nepodáva, výnimkou sú epilepsia a alergia na písomný pokyn lekára. Sprístupní sa po schválení spracúvania údajov škôlkou.')}
 <div class="card"><div class="lbl">Súhlasy</div><label class="row sp">Výlety mimo areálu MŠ<input type="checkbox" data-c="consent" data-child="${k.id}" ${trips?.granted ? 'checked' : ''}></label></div>
 <div class="card"><div class="lbl">Škôlka</div><div>J. Bánika 1733/41, Zvolen · prevádzka 6:30–17:00</div><div class="mute">Príchod do 8:00. Vyzdvihnutie pred spaním do 12:00, inak po 15:00.</div>
  <div class="row sp"><span>Trieda</span><a href="tel:0908618373">0908 618 373</a></div><div class="row sp"><span>Strava (vedúca ŠJ)</span><a href="tel:0917287956">0917 287 956</a></div><div class="row sp"><span>Riaditeľka · konzultácie 12:00–12:30</span><a href="tel:0917287813">0917 287 813</a></div></div>`
}

V.class = () => {
  const c = cls(S.cls), rows = kidsIn(S.cls).map(k => ({ k, ...status(k.id, TODAY) })), n = s => rows.filter(r => r.s == s).length
  const subs = S.d.staff.filter(x => x.substitute_id == S.me.id && x.day == TODAY)
  const tile = (v, l, o) => `<div class="card" style="gap:2px;${o ? 'background:var(--o);border-color:#F3D2AE;color:var(--ot)' : ''}"><div class="disp" style="font-size:26px">${v}</div><div style="font-size:12px;font-weight:600">${l}</div></div>`
  return `<header><div class="mute" style="font-weight:600">${sk(TODAY)}</div><h1 style="font-size:28px">${esc(c.name)}</h1></header>
 <div class="chips">${S.d.classes.map(x => `<button class="chip ${x.id == S.cls ? 'on' : ''}" data-a="cls" data-id="${x.id}">${esc(x.name)}</button>`).join('')}</div>
 ${subs.map(x => `<div class="banner" style="background:var(--b);color:var(--bt)"><b>Záskok dnes:</b> trieda ${esc(classOf(x.teacher_id).name)} za ${esc(pname(x.teacher_id))}.</div>`).join('')}
 <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px">${tile(n('ok') + '/' + rows.length, 'prítomní')}${tile(n('abs'), 'odhlásení')}${tile(n('miss'), 'neohlásení', n('miss'))}</div>
 <div class="card list" style="padding-block:4px">${rows.map(r => { const ps = S.d.pickups.filter(p => p.child_id == r.k.id)
    return `<div class="row"><div class="grow"><b>${esc(r.k.name)}</b>
   ${r.s == 'abs' ? `<div class="mute">${esc(r.a.reason)} · do ${sk(r.a.date_to)}${r.a.note ? ' · ' + esc(r.a.note) : ''}</div>` : ''}
   ${ps.filter(p => p.authorized).length ? `<div class="mute" style="color:var(--bt)">môže vyzdvihnúť aj: ${ps.filter(p => p.authorized).map(p => esc(p.name)).join(', ')}</div>` : ''}
   ${ps.filter(p => !p.authorized).map(p => `<button class="btn ghost" style="font-size:13px" data-a="authorize" data-id="${p.id}">Potvrdiť splnomocnenie: ${esc(p.name)}</button>`).join('')}</div>
   ${r.s == 'abs' ? '<span class="pill">Odhlásený</span>' : r.s == 'miss' ? `<button class="btn ghost" style="color:var(--ot)" data-a="thread" data-id="${r.k.id}" data-go="msg">Kontaktovať</button><button class="pill o" data-a="toggleAtt" data-id="${r.k.id}">Chýba</button>` : `<button class="pill g" data-a="toggleAtt" data-id="${r.k.id}">Prítomný</button>`}</div>` }).join('') || '<div class="mute">V triede nie sú deti.</div>'}</div>
 <div class="mute">Ťuknutím prepnete Prítomný / Chýba. Ukladá sa hneď.</div>`
}

V.posts = () => {
  const d = S.draft ??= { scope: S.cls ?? 'all', type: 'oznam', title: '', text: '', opts: '', date: NEXT, req: true, pin: false }
  const mine = S.d.posts.filter(p => p.require_read)
  const scopes = [...S.d.classes.map(c => [c.id, c.name]), ['all', 'Celá MŠ']]
  return `${adminTabs()}<h1 style="font-size:24px">Nový oznam</h1><form class="card" data-a="publish">
  <div class="f">Komu<div class="chips">${scopes.map(([v, l]) => `<button type="button" class="chip ${d.scope == v ? 'on' : ''}" data-a="draft" data-k="scope" data-val="${v}">${esc(l)}</button>`).join('')}</div></div>
  <div class="f">Typ<div class="chips">${Object.entries(TYPES).map(([v, l]) => `<button type="button" class="chip ${d.type == v ? 'on' : ''}" data-a="draft" data-k="type" data-val="${v}">${l}</button>`).join('')}</div></div>
  <label class="f">Nadpis<input data-d="title" value="${esc(d.title)}" required maxlength="120"></label>
  <label class="f">Text<textarea rows="3" data-d="text">${esc(d.text)}</textarea></label>
  ${d.type == 'anketa' ? `<label class="f">Možnosti (každá na nový riadok)<textarea rows="3" data-d="opts" required>${esc(d.opts)}</textarea></label>` : ''}
  ${d.type == 'udalost' || d.type == 'prineste' ? `<label class="f">${d.type == 'udalost' ? 'Dátum' : 'Prineste do'}<input type="date" data-d="date" min="${TODAY}" value="${d.date}" required></label>` : ''}
  ${[['req', 'Vyžadovať potvrdenie prečítania'], ['pin', 'Pripnúť na vrch']].map(([k, l]) => `<label class="row sp">${l}<input type="checkbox" data-d="${k}" ${d[k] ? 'checked' : ''}></label>`).join('')}
  <button class="btn">Zverejniť ${parentsIn(d.scope == 'all' ? null : d.scope).length} rodičom</button></form>
 <div class="lbl">Prečítanie oznamov</div>
 ${mine.map(p => { const all = parentsIn(p.class_id), rd = readBy(p), un = all.filter(u => !rd.includes(u))
    return `<div class="card"><div class="row sp"><b>${esc(p.title)}</b><span class="mute">${all.length - un.length} z ${all.length}</span></div><div style="height:8px;border-radius:4px;background:#EEEAE0"><div style="height:8px;border-radius:4px;background:var(--g);width:${all.length ? (all.length - un.length) / all.length * 100 : 0}%"></div></div>${un.length ? `<details><summary class="mute">Neprečítali (${un.length})</summary><div class="mute">${un.map(pname).map(esc).join(', ')}</div></details>` : ''}</div>` }).join('') || '<p class="mute">Žiadne oznamy s potvrdením.</p>'}`
}

V.over = () => adminTabs() + `<h1 style="font-size:28px">Prehľad · ${sk(TODAY)}</h1><div class="cols">${S.d.classes.map(c => { const ss = kidsIn(c.id).map(k => status(k.id, TODAY).s), cnt = s => ss.filter(x => x == s).length
  return `<div class="card"><div class="row sp"><b style="font-size:17px">${esc(c.name)}</b>${cnt('miss') ? `<span class="pill o">${cnt('miss')} neohlásené</span>` : ''}</div><div class="disp" style="font-size:32px;color:var(--g)">${cnt('ok')}<span class="mute" style="font-size:16px"> / ${ss.length} prítomných</span></div><div class="mute">${cnt('abs')} odhlásené · ${teachersOf(c.id).map(t => esc(pname(t)) + (S.d.staff.some(x => x.teacher_id == t && x.day == TODAY) ? ' (nie je)' : '')).join(', ')}</div></div>` }).join('')}</div>
 <div class="card"><div class="lbl">Na vyriešenie</div>${todo()}</div>`

V.staff = () => {
  const wk = [0, 1, 2, 3, 4].map(i => add(MON, i)), ts = teachers()
  const subFor = (t, d) => S.d.staff.filter(x => x.substitute_id == t && x.day == d).map(x => ' + ' + esc(classOf(x.teacher_id).name)).join('')
  return adminTabs() + `<h1 style="font-size:28px">Personál · týždeň od ${sk(MON)}</h1><div class="card" style="overflow-x:auto"><table><tr><th>Učiteľka</th>${wk.map(d => `<th>${sk(d)}</th>`).join('')}</tr>
 ${ts.map(t => `<tr><td><b>${esc(t.full_name || t.email)}</b><div class="mute">${esc(classOf(t.id).name)}</div></td>${wk.map(d => { const a = S.d.staff.find(x => x.teacher_id == t.id && x.day == d)
    return `<td style="min-width:130px">${a
      ? `<button class="cell abs" data-a="staff" data-t="${t.id}" data-d="${d}">Neprítomná</button><select aria-label="Záskok" data-c="sub" data-t="${t.id}" data-d="${d}" style="margin-top:6px;min-height:38px;padding:4px 8px;font-size:13px"><option value="">– záskok –</option>${ts.filter(x => x.id != t.id && !S.d.staff.some(y => y.teacher_id == x.id && y.day == d)).map(x => `<option value="${x.id}" ${a.substitute_id == x.id ? 'selected' : ''}>${esc(x.full_name || x.email)}</option>`).join('')}</select>`
      : `<button class="cell" data-a="staff" data-t="${t.id}" data-d="${d}">${esc(classOf(t.id).name)}${subFor(t.id, d)}</button>`}</td>` }).join('')}</tr>`).join('')}</table>
 <div class="mute">Klik na bunku = neprítomnosť. Dôvod sa neeviduje, len trvanie.</div></div><div class="card"><div class="lbl">Na vyriešenie</div>${todo()}</div>`
}

V.report = () => {
  const month = TODAY.slice(0, 8) + '01', last = iso(new Date(dt(month).getFullYear(), dt(month).getMonth() + 1, 0))
  const wd = days(month, last).filter(d => d <= TODAY)
  S.rep = S.d.children.map(k => [cls(k.class_id).name, k.name, wd.length, wd.filter(d => status(k.id, d).s != 'ok').length])
  return adminTabs() + `<div class="row sp" style="flex-wrap:wrap"><h1 style="font-size:28px">Výkaz dochádzky · ${dt(month).toLocaleDateString('sk', { month: 'long', year: 'numeric' })}</h1><button class="btn" data-a="csv">Stiahnuť CSV</button></div>
 <div class="card" style="overflow-x:auto"><table><tr><th>Trieda</th><th>Dieťa</th><th class="n">Prac. dni</th><th class="n">Neprítomný</th><th class="n">Prítomný</th></tr>${S.rep.map(r => `<tr><td>${esc(r[0])}</td><td>${esc(r[1])}</td><td class="n">${r[2]}</td><td class="n">${r[3]}</td><td class="n">${r[2] - r[3]}</td></tr>`).join('')}</table>
 <div class="mute">Do dnešného dňa. Neprítomnosť = odhlásenie alebo „Chýba“ v dochádzke.</div></div>`
}

V.kitchen = () => {
  const open = mealOpen(KITCHEN_DAY), tot = S.d.meals.reduce((s, c) => s + c.portions, 0)
  const wk = [0, 1, 2, 3, 4].map(i => add(MON, i + S.week * 7))
  return `${S.role == 'admin' ? adminTabs() : logo()}<div class="row sp" style="flex-wrap:wrap"><h1 style="font-size:28px">Porcie na ${sk(KITCHEN_DAY)}</h1><span class="pill ${open ? 'o' : 'g'}" style="font-size:14px;padding:8px 12px">${open ? `Uzávierka ${DEADLINE}:00 · počty sa ešte menia` : `Uzavreté o ${DEADLINE}:00 · počty sú finálne`}</span></div>
 <div class="cols"><div class="card"><table><tr><th>Trieda</th><th class="n">Porcie</th></tr>${S.d.meals.map(c => `<tr><td><b>${esc(c.class_name)}</b></td><td class="n" style="font-size:18px">${c.portions}</td></tr>`).join('')}<tr><td class="disp" style="font-size:18px">Spolu</td><td class="n disp" style="font-size:24px;color:var(--g)">${tot}</td></tr></table><button class="btn ghost" style="align-self:flex-start" data-a="refresh">Obnoviť</button></div>
 ${lock('Diéty a alergie', 'Po schválení tu kuchyňa uvidí počty diétnych porcií podľa triedy, bez kontaktov na rodičov.')}</div>
 <form class="card" data-a="saveMenu" style="overflow-x:auto"><div class="row sp" style="flex-wrap:wrap"><div class="lbl">Jedálny lístok · týždeň od ${sk(wk[0])}</div><div class="chips">${['Tento týždeň', 'Budúci týždeň'].map((l, i) => `<button type="button" class="chip ${S.week == i ? 'on' : ''}" data-a="week" data-i="${i}">${l}</button>`).join('')}</div></div>
 <table><tr><th>Deň</th><th>Desiata</th><th>Obed</th><th>Olovrant</th></tr>${wk.map(d => { const m = S.d.menu.find(x => x.day == d) ?? {}
    return `<tr><td><b>${sk(d)}</b></td>${['snack', 'lunch', 'afternoon'].map(k => `<td><input name="${d}|${k}" aria-label="${sk(d)} ${k}" value="${esc(m[k])}"></td>`).join('')}</tr>` }).join('')}</table>
 <div class="row sp"><span class="mute">Alergény píšte do zátvorky, napr. (1, 7).</span><button class="btn">Uložiť a zverejniť</button></div></form>`
}

// ---------- akcie ----------
const A = {
  go: d => { S.v = d.v; scrollTo(0, 0) },
  filter: d => { S.filter = d.f },
  child: d => { S.child = +d.id; S.form = null },
  cls: d => { S.cls = +d.id; S.draft = null },
  thread: d => { S.thread = d.id ? +d.id : null; if (d.go) S.v = d.go },
  week: d => { S.week = +d.i },
  mode: () => { S.reg = !S.reg },
  recheck: () => boot(),
  refresh: () => {}, // run() po akcii dáta aj tak znovu načíta
  logout: () => sb.auth.signOut(),
  push: () => enablePush(),
  confirm: async d => { await q(sb.from('post_reads').insert({ post_id: d.id })); toast('Potvrdené') },
  vote: async d => { await q(sb.from('poll_votes').insert({ post_id: d.id, choice: +d.i })) },
  reason: d => { S.form.r = d.r },
  submitAbs: async () => {
    const f = S.form, k = myKid()
    const a = await q(sb.from('absences').insert({ child_id: k.id, date_from: f.from, date_to: f.to, reason: f.r, note: f.note }).select().single())
    S.form = null; S.v = 'board'
    toast(a.meals_from ? `Odhlásené · strava od ${sk(a.meals_from)}` : 'Odhlásené · strava už po uzávierke')
  },
  cancelAbs: async d => { await q(sb.from('absences').delete().eq('id', d.id)); toast('Odhlásenie zrušené') },
  toggleAtt: async d => {
    const k = +d.id
    if (status(k, TODAY).s == 'miss') await q(sb.from('attendance').delete().eq('child_id', k).eq('day', TODAY))
    else await q(sb.from('attendance').insert({ child_id: k, day: TODAY }))
  },
  authorize: async d => { await q(sb.from('pickups').update({ authorized: true }).eq('id', d.id)); toast('Splnomocnenie potvrdené') },
  rmPick: async d => { await q(sb.from('pickups').delete().eq('id', d.id)) },
  draft: d => { S.draft[d.k] = d.val },
  staff: async d => {
    const a = S.d.staff.find(x => x.teacher_id == d.t && x.day == d.d)
    if (a) return q(sb.from('staff_absences').delete().eq('teacher_id', d.t).eq('day', d.d))
    await q(sb.from('staff_absences').insert({ teacher_id: d.t, day: d.d }))
    await q(sb.from('staff_absences').update({ substitute_id: null }).eq('substitute_id', d.t).eq('day', d.d)) // neprítomná nemôže zastupovať
  },
  csv: () => {
    const t = [['Trieda', 'Dieťa', 'Pracovné dni', 'Neprítomný', 'Prítomný'], ...S.rep.map(r => [...r, r[2] - r[3]])].map(r => r.join(';')).join('\n')
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['﻿' + t], { type: 'text/csv' })); a.download = `dochadzka-${TODAY.slice(0, 7)}.csv`; a.click()
  },
}
const F = {
  login: async fd => {
    const { error } = await sb.auth.signInWithPassword({ email: fd.email.trim(), password: fd.password })
    if (error) throw new Error(/invalid/i.test(error.message) ? 'Nesprávny e-mail alebo heslo.' : error.message)
    await boot()
  },
  register: async fd => {
    const { data, error } = await sb.auth.signUp({ email: fd.email.trim(), password: fd.password, options: { data: { full_name: fd.name.trim(), requested_child: fd.child.trim() } } })
    if (error) throw new Error(/registered/i.test(error.message) ? 'Tento e-mail už je zaregistrovaný.' : error.message)
    if (!data.session) return toast('Potvrďte registráciu odkazom v e-maile.')
    await boot()
  },
  approve: async (fd, f) => {
    const kids = new FormData(f).getAll('child')
    if (kids.length) await q(sb.from('guardians').insert(kids.map(c => ({ child_id: +c, parent_id: f.dataset.id }))))
    await q(sb.from('profiles').update({ approved: true, role: fd.role }).eq('id', f.dataset.id))
    toast('Schválené')
  },
  addChild: async fd => { await q(sb.from('children').insert({ name: fd.name.trim(), class_id: +fd.cls })); toast('Dieťa pridané') },
  send: async (fd, f) => { await q(sb.from('messages').insert({ child_id: +f.dataset.child, body: fd.t.trim() })) },
  addPick: async (fd, f) => { await q(sb.from('pickups').insert({ child_id: +f.dataset.child, name: fd.n.trim(), relation: fd.r.trim() })); toast('Pridané · odovzdajte písomné splnomocnenie v MŠ') },
  publish: async () => {
    const d = S.draft, row = { class_id: d.scope == 'all' ? null : +d.scope, type: d.type, title: d.title.trim(), body: d.text.trim(), require_read: d.req, pinned: d.pin }
    if (d.type == 'anketa') { row.poll_options = d.opts.split('\n').map(s => s.trim()).filter(Boolean); if (row.poll_options.length < 2) throw new Error('Anketa potrebuje aspoň 2 možnosti.') }
    if (d.type == 'udalost' || d.type == 'prineste') row.event_date = d.date
    await q(sb.from('posts').insert(row))
    S.draft = null; toast('Zverejnené · rodičia dostanú upozornenie')
  },
  saveMenu: async fd => {
    const rows = {}
    for (const [k, v] of Object.entries(fd)) { const [day, col] = k.split('|'); (rows[day] ??= { day })[col] = v.trim() }
    await q(sb.from('menu').upsert(Object.values(rows)))
    toast('Jedálny lístok uložený')
  },
}

// ---------- push ----------
async function enablePush() {
  if (!VAPID_PUBLIC_KEY || !('serviceWorker' in navigator) || !('PushManager' in window)) return toast('Upozornenia tu nefungujú. Na iPhone najprv pridajte stránku na plochu a otvorte ju odtiaľ.')
  if (await Notification.requestPermission() != 'granted') return toast('Upozornenia sú v prehliadači zakázané.')
  const key = Uint8Array.from(atob(VAPID_PUBLIC_KEY.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))
  const sub = (await (await navigator.serviceWorker.ready).pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })).toJSON()
  await q(sb.from('push_subscriptions').upsert({ endpoint: sub.endpoint, subscription: sub }))
  S.push = true; toast('Upozornenia zapnuté')
}

// ---------- beh ----------
let tt
function toast(m) { const t = document.getElementById('toast'); t.textContent = m; t.classList.add('on'); clearTimeout(tt); tt = setTimeout(() => t.classList.remove('on'), 3000) }

function render() {
  const app = document.getElementById('app'), nav = document.getElementById('nav'), bar = document.getElementById('bar')
  if (!S.me) { app.className = ''; nav.hidden = true; bar.innerHTML = ''; app.innerHTML = V.login(); return }
  const wide = S.role == 'admin' && S.v != 'posts' || S.role == 'kitchen'
  app.className = wide ? 'wide' : ''
  app.innerHTML = V[S.v]()
  bar.innerHTML = `<span><b>${esc(S.me.full_name || S.me.email)}</b> · ${ROLE[S.role]}</span>${S.push || !VAPID_PUBLIC_KEY ? '' : '<button data-a="push">Zapnúť upozornenia</button>'}${S.role == 'admin' && S.v == 'posts' ? '<button data-a="go" data-v="over">Späť na prehľad</button>' : ''}<button data-a="logout">Odhlásiť sa</button>`
  nav.hidden = !TABS[S.role] || S.role == 'admin' || !S.me.approved
  if (!nav.hidden) nav.innerHTML = TABS[S.role].map(([v, l, i]) => `<button data-a="go" data-v="${v}" class="${S.v == v ? 'on' : ''}">${ic(i)}${l}</button>`).join('')
}

// Po každej zmene načítame dáta znovu. Pri pár desiatkach rodín to stačí, realtime pridáme, až bude treba.
async function run(fn) {
  try { await fn(); if (S.me?.approved) await load() } catch (e) { console.error(e); toast(e.message || 'Niečo sa nepodarilo.') }
  render()
}
document.addEventListener('click', e => { const b = e.target.closest('[data-a]'); if (!b || b.tagName == 'FORM') return; run(() => A[b.dataset.a](b.dataset)) })
document.addEventListener('submit', e => { e.preventDefault(); const f = e.target; run(() => F[f.dataset.a](Object.fromEntries(new FormData(f)), f)) })
document.addEventListener('input', e => { const el = e.target; if (el.dataset.c == 'note') S.form.note = el.value; if (el.dataset.d && el.type != 'checkbox' && el.type != 'date') S.draft[el.dataset.d] = el.value })
document.addEventListener('change', e => {
  const el = e.target, c = el.dataset.c
  if ((c == 'from' || c == 'to') && el.value) { S.form[c] = el.value; if (S.form.to < S.form.from) S.form.to = S.form.from; render() }
  if (c == 'consent') run(() => q(sb.from('consents').upsert({ child_id: +el.dataset.child, kind: 'vylety', granted: el.checked, updated_at: new Date().toISOString() })))
  if (c == 'sub') run(() => q(sb.from('staff_absences').update({ substitute_id: el.value || null }).eq('teacher_id', el.dataset.t).eq('day', el.dataset.d)))
  if (el.dataset.d) S.draft[el.dataset.d] = el.type == 'checkbox' ? el.checked : el.value
})
document.addEventListener('visibilitychange', () => { if (!document.hidden && S.me) run(() => {}) })
sb.auth.onAuthStateChange(ev => { if (ev == 'SIGNED_OUT') location.reload() })

async function boot() {
  const { data: { session } } = await sb.auth.getSession()
  if (!session) return
  S.me = await q(sb.from('profiles').select('*').eq('id', session.user.id).single())
  S.role = S.me.role; S.v = S.me.approved ? (S.v && S.v != 'pending' ? S.v : DEF[S.role]) : 'pending'
  const reg = await navigator.serviceWorker?.register('sw.js').catch(() => null)
  S.push = !!(await reg?.pushManager?.getSubscription())
}
run(boot)
