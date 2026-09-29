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
const PREV_MONTH = iso(new Date(dt(TODAY).getFullYear(), dt(TODAY).getMonth() - 1, 1))
// telefón v tvare +421 xxx xxx xxx (0908… → +421 908…); čo nevieme rozpoznať, nechá tak
const phone = s => { let d = String(s).replace(/[^\d+]/g, ''); if (d.startsWith('00')) d = '+' + d.slice(2); else if (d.startsWith('0')) d = '+421' + d.slice(1); return /^\+421\d{9}$/.test(d) ? d.replace(/(\d{3})(\d{3})(\d{3})$/, ' $1 $2 $3') : String(s).trim() }
const tel = s => 'tel:' + phone(s).replace(/\s/g, '')
const first = n => String(n).split(' ')[0]

const ROLE = { parent: 'Rodič', teacher: 'Učiteľka', admin: 'Vedenie', kitchen: 'Kuchyňa' }
const DEF = { parent: 'board', teacher: 'class', admin: 'over', kitchen: 'kitchen' }
const TYPES = { oznam: 'Oznam', prineste: 'Prineste', anketa: 'Anketa', udalost: 'Udalosť' }
const REASONS = ['Choroba', 'Rodinné dôvody', 'Dovolenka', 'Návšteva lekára', 'Iné']

const S = { me: null, role: null, v: null, d: {}, filter: 'all', form: null, draft: null, thread: null, week: 0, reg: false, forgot: false, recovery: false, push: false, menu: false, bell: false, wizChecked: false,
  day: TODAY, since: PREV_MONTH, repMonth: TODAY.slice(0, 7), absKid: null }

// ---------- dáta ----------
const q = async p => { const { data, error } = await p; if (error) throw error; return data }
async function load() {
  const r = S.role, D = S.d
  Object.assign(D, Object.fromEntries(await Promise.all(Object.entries({
    classes: sb.from('classes').select('*').order('sort'),
    ct: sb.from('class_teachers').select('*'),
    profiles: sb.from('profiles').select('id, full_name, email, role, approved, blocked, requested_child'),
    posts: sb.from('posts').select('*').order('created_at', { ascending: false }).limit(100),
    reads: sb.from('post_reads').select('post_id, user_id'),
    votes: sb.from('poll_votes').select('post_id, user_id, choice'),
    menu: sb.from('menu').select('*').gte('day', MON).lte('day', add(MON, 11)),
    settings: sb.from('settings').select('*'),
    notes: sb.from('notifications').select('*').order('created_at', { ascending: false }).limit(30),
    prefs: sb.from('notification_prefs').select('*'),
  }).map(async ([k, p]) => [k, await q(p)]))))
  if (r == 'kitchen' || r == 'admin') {
    D.meals = await q(sb.rpc('meal_counts', { d: KITCHEN_DAY }))
    D.diets = healthOn() ? await q(sb.rpc('diet_counts', { d: KITCHEN_DAY })) : []
  }
  if (r == 'kitchen') return
  Object.assign(D, Object.fromEntries(await Promise.all(Object.entries({
    children: sb.from('children').select('*').eq('active', true).order('name'),
    inactive: r == 'admin' ? sb.from('children').select('*').eq('active', false).order('name') : Promise.resolve({ data: [] }),
    guardians: sb.from('guardians').select('*'),
    absences: sb.from('absences').select('*').gte('date_to', S.since).order('date_from'),
    attendance: sb.from('attendance').select('*').gte('day', S.since),
    pickups: sb.from('pickups').select('*').order('created_at'),
    consents: sb.from('consents').select('*'),
    emergency: sb.from('emergency_contacts').select('*').order('created_at'),
    health: sb.from('child_health').select('*'),   // prázdne, kým je zdravie vypnuté
    msgs: sb.from('messages').select('*').order('created_at', { ascending: false }).limit(300),
    treads: sb.from('thread_reads').select('*'),
    staff: r == 'parent' ? Promise.resolve({ data: [] }) : sb.from('staff_absences').select('*').gte('day', MON).lte('day', add(MON, 4)),
  }).map(async ([k, p]) => [k, await q(p)]))))
  S.child ??= D.children[0]?.id
  S.cls ??= D.ct.find(x => x.teacher_id == S.me.id)?.class_id ?? D.classes[0]?.id
  // otvorené vlákno = prečítané
  const open = S.v == 'msg' && (S.role == 'parent' ? S.child : S.thread)
  if (open && unread(open)) {
    const row = { user_id: S.me.id, child_id: open, read_at: new Date().toISOString() }
    await q(sb.from('thread_reads').upsert(row))
    D.treads = D.treads.filter(x => x.child_id != open).concat(row)
  }
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
const teachers = () => S.d.profiles.filter(p => p.approved && !p.blocked && (p.role == 'teacher' || p.role == 'admin'))
const healthOn = () => !!S.d.settings?.find(s => s.key == 'health_enabled')?.value
// Neprečítané: rodič = jeho deti, učiteľka/admin = deti tried, kde sú priradení.
const myThreads = () => S.role == 'parent' ? S.d.children.map(k => k.id) : S.d.children.filter(k => S.d.ct.some(x => x.teacher_id == S.me.id && x.class_id == k.class_id)).map(k => k.id)
const unread = c => { const r = S.d.treads?.find(x => x.child_id == c)?.read_at; return S.d.msgs.filter(m => m.child_id == c && m.sender_id != S.me.id && (!r || new Date(m.created_at) > new Date(r))).length }
const unreadAll = () => S.d.msgs ? myThreads().reduce((s, c) => s + unread(c), 0) : 0
const badge = n => n ? ` <span class="pill o" style="padding:1px 7px">${n}</span>` : ''

// ---------- UI kúsky ----------
const I = { home: '<path d="M4 10l8-6 8 6v9a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z"/>', cal: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/>', chat: '<path d="M5 5h14a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9l-4 3V6a1 1 0 0 1 1-1z"/>', kid: '<circle cx="12" cy="8" r="4"/><path d="M4 20c1.5-4 4.5-6 8-6s6.5 2 8 6"/>', lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>', ok: '<path d="M5 12l5 5 9-10"/>', group: '<circle cx="9" cy="8" r="3"/><circle cx="17" cy="9" r="2.5"/><path d="M3 19c1-3 3.5-5 6-5s5 2 6 5M15 14.5c2.5 0 4.5 1.5 5.5 4"/>', mega: '<path d="M4 10v4h3l7 5V5L7 10z"/><path d="M18 9a4 4 0 0 1 0 6"/>', back: '<path d="M15 5l-7 7 7 7"/>', bell: '<path d="M6 16v-5a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 21h4"/>', card: '<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18M7 15h4"/>' }
const ic = n => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${I[n]}</svg>`
const TABS = { parent: [['board', 'Nástenka', 'home'], ['cal', 'Kalendár', 'cal'], ['msg', 'Správy', 'chat'], ['pay', 'Platby', 'card'], ['kid', 'Dieťa', 'kid']], teacher: [['class', 'Trieda', 'group'], ['posts', 'Oznamy', 'mega'], ['msg', 'Správy', 'chat'], ['cal', 'Kalendár', 'cal']], admin: [['over', 'Prehľad'], ['class', 'Trieda'], ['msg', 'Správy'], ['cal', 'Kalendár'], ['users', 'Používatelia'], ['staff', 'Personál'], ['report', 'Výkaz'], ['kitchen', 'Kuchyňa'], ['posts', 'Oznamy']] }
const logo = () => `<div class="row"><img src="icon-192.png" width="36" height="36" alt=""><div><div class="disp" style="font-size:22px">Ďatelinka</div><div class="mute" style="font-size:12px">Materská škola Zvolen</div></div></div>`
const lock = (t, d) => `<div class="lock">${ic('lock')}<div><div class="row" style="gap:8px"><b>${t}</b><span class="gdpr">Podlieha GDPR</span></div><div class="mute" style="margin-top:4px">${d}</div></div></div>`
const adminTabs = () => S.role != 'admin' ? '' : `<div class="row sp" style="flex-wrap:wrap">${logo()}<div class="chips">${TABS.admin.map(([v, l]) => `<button class="chip ${S.v == v ? 'on' : ''}" data-a="go" data-v="${v}">${l}${v == 'msg' ? badge(unreadAll()) : ''}</button>`).join('')}</div></div>`
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
  return `<article class="card" ${p.type == 'prineste' ? 'style="background:var(--y);border-color:var(--yb)"' : ''}>
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
  : S.forgot
  ? `<form class="card" data-a="forgot"><h2 style="font-size:20px">Zabudnuté heslo</h2><label class="f">E-mail<input name="email" type="email" autocomplete="email" required></label>
     <button class="btn">Poslať odkaz na nové heslo</button><div class="mute">Ak e-mail nepríde, ozvite sa v škôlke. Heslo vám vie obnoviť správca.</div>
     <button type="button" class="btn ghost" data-a="forgotMode">Späť na prihlásenie</button></form>`
  : `<form class="card" data-a="login"><label class="f">E-mail<input name="email" type="email" autocomplete="email" required></label>
     <label class="f">Heslo<input name="password" type="password" autocomplete="current-password" required></label>
     <button class="btn">Prihlásiť sa</button><button type="button" class="btn ghost" data-a="mode">Nemám účet – registrácia</button><button type="button" class="btn ghost" data-a="forgotMode">Zabudnuté heslo</button></form>`}`

V.pending = () => `${logo()}<div class="card">${S.me.blocked
  ? '<h2 style="font-size:20px">Účet nie je aktívny</h2><div>Registráciu škôlka zamietla alebo účet deaktivovala. Ak ide o omyl, ozvite sa v škôlke.</div>'
  : `<h2 style="font-size:20px">Účet čaká na schválenie</h2><div>Riaditeľka skontroluje registráciu a priradí vám dieťa${S.me.requested_child ? ` (<b>${esc(S.me.requested_child)}</b>)` : ''}. Potom sa vám platforma sprístupní.</div><button class="btn out" data-a="recheck">Skontrolovať znova</button>`}</div>`

V.password = () => `<header class="row"><button class="btn ghost" aria-label="Späť" data-a="go" data-v="${S.me.approved ? DEF[S.role] : 'pending'}">${ic('back')}</button><h1 style="font-size:22px">${S.recovery ? 'Nastavte si nové heslo' : 'Zmena hesla'}</h1></header>
 <form class="card" data-a="setPassword"><label class="f">Nové heslo (aspoň 8 znakov)<input name="p1" type="password" autocomplete="new-password" minlength="8" required></label>
 <label class="f">Nové heslo znova<input name="p2" type="password" autocomplete="new-password" minlength="8" required></label><button class="btn">Uložiť heslo</button></form>`

// Sprievodca: rodič má mať pri každom dieťati aspoň jednu osobu na vyzdvihnutie a jeden núdzový kontakt
const gaps = () => S.role != 'parent' ? [] : S.d.children.flatMap(k => [!S.d.pickups.some(p => p.child_id == k.id) && [k, 'pick'], !S.d.emergency.some(e => e.child_id == k.id) && [k, 'contact']].filter(Boolean))
const gapText = () => gaps().map(([k, t]) => `${esc(first(k.name))}: ${t == 'pick' ? 'osoba na vyzdvihnutie' : 'núdzový kontakt'}`).join(' · ')
V.wizard = () => {
  const k = myKid()
  if (!k) return `${logo()}<div class="card">Zatiaľ nemáte priradené dieťa. Riaditeľka vám ho priradí po schválení účtu, prípadne sa ozvite v škôlke.</div>`
  const pk = S.d.pickups.some(p => p.child_id == k.id), ec = S.d.emergency.some(e => e.child_id == k.id)
  const steps = [[`Dieťa: ${esc(k.name)} · ${esc(cls(k.class_id).name)}`, true], ['Kto môže vyzdvihnúť dieťa', pk], ['Núdzový kontakt', ec]], cur = steps.findIndex(x => !x[1])
  const others = gaps().filter(g => g[0].id != k.id).length
  const form = [null,
    `<div class="mute">Pridajte aspoň jednu osobu (aj seba). Učiteľka jej dieťa odovzdá až po odovzdaní písomného splnomocnenia v škôlke.</div>${S.d.pickups.filter(p => p.child_id == k.id).map(p => `<div><b>${esc(p.name)}</b> <span class="mute">${esc(p.relation)}</span></div>`).join('')}
     <form class="grid2" data-a="addPick" data-child="${k.id}"><input name="n" aria-label="Meno" placeholder="Meno a priezvisko" required><input name="r" aria-label="Vzťah" placeholder="Vzťah (mama, babka…)" required><button class="btn" style="grid-column:span 2">Pridať osobu</button></form>`,
    `<div class="mute">Kontakt, na ktorý sa škôlka dovolá, keď ste nedostupní. Ďalšie pridáte neskôr v karte Dieťa.</div>
     <form class="grid2" data-a="addContact" data-child="${k.id}"><input name="n" aria-label="Meno" placeholder="Meno a priezvisko" required><input name="r" aria-label="Vzťah" placeholder="Vzťah"><input name="p" type="tel" aria-label="Telefón" placeholder="Telefón (+421 9xx xxx xxx)" required style="grid-column:span 2"><button class="btn" style="grid-column:span 2">Pridať kontakt</button></form>`][cur]
  return `${logo()}${kidChips()}<h1 style="font-size:24px">${cur < 0 ? 'Všetko je vyplnené' : 'Doplňte údaje'}</h1>
 <div class="card">${steps.map(([l, ok], i) => `<div class="st"><span class="dot ${ok ? 'ok' : i == cur ? 'cur' : ''}">${ok ? ic('ok') : i + 1}</span><span ${i == cur ? 'style="font-weight:700"' : ok ? 'class="mute"' : ''}>${l}</span></div>`).join('')}</div>
 ${cur < 0 ? `<div class="card">Ďakujeme, škôlka má všetko potrebné.${others ? ` Ešte treba doplniť údaje pri ďalšom dieťati.` : ''}<button class="btn" data-a="go" data-v="board">Pokračovať</button></div>`
   : `<div class="card"><div class="lbl">Krok ${cur + 1} z 3</div>${form}</div><button class="btn ghost" data-a="go" data-v="board">Neskôr</button>`}`
}
const pref = k => S.d.prefs?.[0]?.[k] ?? true
const unseen = () => S.d.notes?.filter(n => !n.read_at).length || 0
const THEMES = [['auto', 'Auto'], ['light', 'Svetlý'], ['dark', 'Tmavý']]
V.settings = () => `<header class="row"><button class="btn ghost" aria-label="Späť" data-a="go" data-v="${DEF[S.role]}">${ic('back')}</button><h1 style="font-size:22px">Upozornenia</h1></header>
 <div class="card"><div class="lbl">O čom chcem vedieť</div>
  ${[['posts', 'Nové oznamy', S.role == 'parent'], ['reminders', 'Ranná pripomienka odhlásenia (7:30)', S.role == 'parent'], ['messages', 'Nové správy', S.role != 'kitchen'], ['absences', 'Odhlásenia detí', S.role == 'teacher' || S.role == 'admin']].filter(x => x[2]).map(([k, l]) => `<label class="row"><input type="checkbox" data-c="pref" data-k="${k}" ${pref(k) ? 'checked' : ''}><span>${l}</span></label>`).join('')}
  <div class="mute">Vypnutý druh sa nezobrazí ani v zvončeku, ani ako push.</div></div>
 <div class="card"><div class="lbl">Push do zariadenia</div>
  <label class="row"><input type="checkbox" data-c="pref" data-k="push" ${pref('push') ? 'checked' : ''}><span>Posielať push upozornenia</span></label>
  <div class="mute">${S.push ? 'Na tomto zariadení sú zapnuté.' : 'Na tomto zariadení zatiaľ nie sú zapnuté.'}</div>
  <div class="row">${S.push || !VAPID_PUBLIC_KEY ? '' : '<button class="btn" data-a="push">Zapnúť na tomto zariadení</button>'}<button class="btn out" data-a="testPush">Poslať skúšobné upozornenie</button></div></div>`
// Okno pripravené, platby (škôlka, kuchyňa, ZRPŠ…) doplníme po dohode.
V.pay = () => `${kidChips()}<h1 style="font-size:26px">Platby</h1><div class="card"><div class="mute">Zatiaľ tu nie sú žiadne platby.</div></div>`

// Párovanie registrácie s dieťaťom: zhoda aspoň jedného slova (bez diakritiky, 3+ znaky).
const norm = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
const matches = (req, name) => { const w = norm(name).split(/\s+/); return norm(req).split(/\s+/).some(x => x.length >= 3 && w.some(y => y.startsWith(x) || x.startsWith(y) && y.length >= 3)) }

V.users = () => {
  const P = S.d.profiles, pending = P.filter(p => !p.approved && !p.blocked), active = P.filter(p => p.approved && !p.blocked), blocked = P.filter(p => p.blocked)
  const parents = active.filter(p => p.role == 'parent'), sel = 'min-height:38px;padding:4px 8px;font-size:13px;width:auto'
  const kidsOf = id => S.d.guardians.filter(g => g.parent_id == id).map(g => byId(S.d.children, g.child_id)?.name).filter(Boolean)
  return adminTabs() + `<h1 style="font-size:28px">Používatelia</h1>
 <div class="lbl">Čakajú na schválenie (${pending.length})</div>
 ${pending.map(p => { const hit = S.d.children.filter(k => p.requested_child && matches(p.requested_child, k.name))
    return `<form class="card" data-a="approve" data-id="${p.id}"><div class="row sp" style="flex-wrap:wrap"><div><b>${esc(p.full_name || '–')}</b> <span class="mute">${esc(p.email)}</span></div><span class="pill ${hit.length ? 'g' : 'o'}">${hit.length ? `zhoda: ${hit.length}` : 'bez zhody'}</span></div>
   <div>Uvedené dieťa: <b>${esc(p.requested_child || '–')}</b></div>
   <div class="f">Priradiť k dieťaťu<div class="chips">${S.d.children.map(k => `<label class="chip ${hit.includes(k) ? 'on' : ''}"><input type="checkbox" name="child" value="${k.id}" ${hit.includes(k) ? 'checked' : ''} style="width:16px;height:16px;margin-right:6px;vertical-align:-2px">${esc(k.name)} <span class="mute">${esc(cls(k.class_id).name)}</span></label>`).join('') || '<span class="mute">Najprv pridajte deti nižšie.</span>'}</div></div>
   <div class="row" style="flex-wrap:wrap;align-items:flex-end"><label class="f">Rola<select name="role" style="${sel}">${Object.entries(ROLE).map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></label>
   <button class="btn">Schváliť</button><button type="button" class="btn ghost" style="color:var(--ot)" data-a="block" data-id="${p.id}" data-on="1">Zamietnuť</button></div></form>` }).join('') || '<p class="mute">Nikto nečaká.</p>'}
 <div class="lbl">Aktívni (${active.length})</div>
 <div class="card" style="overflow-x:auto"><table><tr><th>Meno</th><th>E-mail</th><th>Rola</th><th>Deti</th><th></th></tr>${active.map(p => `<tr><td>${esc(p.full_name || '–')}</td><td class="mute">${esc(p.email)}</td>
  <td>${p.id == S.me.id ? ROLE[p.role] : `<select aria-label="Rola" data-c="role" data-id="${p.id}" style="${sel}">${Object.entries(ROLE).map(([v, l]) => `<option value="${v}" ${p.role == v ? 'selected' : ''}>${l}</option>`).join('')}</select>`}</td>
  <td>${kidsOf(p.id).map(esc).join(', ') || (p.role == 'parent' ? '<span class="mute">žiadne</span>' : '')}</td>
  <td>${p.id == S.me.id ? '' : `<button class="btn ghost" style="color:var(--ot)" data-a="block" data-id="${p.id}" data-on="1">Deaktivovať</button>`}</td></tr>`).join('')}</table></div>
 ${blocked.length ? `<div class="lbl">Zamietnutí a deaktivovaní</div><div class="card list" style="padding-block:4px">${blocked.map(p => `<div class="row"><span class="grow">${esc(p.full_name || '–')} <span class="mute">${esc(p.email)}</span></span><button class="btn ghost" data-a="block" data-id="${p.id}" data-on="">Obnoviť</button></div>`).join('')}</div>` : ''}
 <div class="lbl">Deti (${S.d.children.length})</div>
 <form class="card row" data-a="addChild" style="flex-direction:row;flex-wrap:wrap;align-items:flex-end"><label class="f grow">Meno dieťaťa<input name="name" required></label><label class="f">Trieda<select name="cls">${S.d.classes.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></label><button class="btn">Pridať dieťa</button></form>
 <div class="card" style="overflow-x:auto"><table><tr><th>Dieťa</th><th>Trieda</th><th>Rodičia</th><th></th></tr>${S.d.children.map(k => { const gs = S.d.guardians.filter(g => g.child_id == k.id)
    return `<tr><td><input aria-label="Meno" data-c="kname" data-id="${k.id}" value="${esc(k.name)}" style="min-height:38px;padding:4px 8px;min-width:150px"></td>
  <td><select aria-label="Trieda" data-c="kcls" data-id="${k.id}" style="${sel}">${S.d.classes.map(c => `<option value="${c.id}" ${k.class_id == c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></td>
  <td><div class="chips">${gs.map(g => `<span class="chip" style="cursor:default">${esc(pname(g.parent_id))} <button class="btn ghost" style="padding:0 0 0 6px;color:var(--ot)" aria-label="Odobrať rodiča" data-a="unlink" data-child="${k.id}" data-p="${g.parent_id}">×</button></span>`).join('')}
   <select aria-label="Pridať rodiča" data-c="link" data-child="${k.id}" style="${sel}"><option value="">+ rodič</option>${parents.filter(p => !gs.some(g => g.parent_id == p.id)).map(p => `<option value="${p.id}">${esc(p.full_name || p.email)}</option>`).join('')}</select></div></td>
  <td><button class="btn ghost" style="color:var(--ot)" data-a="archive" data-id="${k.id}" data-on="">Vyradiť</button></td></tr>` }).join('')}</table>
 <div class="mute">Meno a trieda sa uložia hneď po zmene. Vyradené dieťa zmizne z tried aj od rodičov.</div></div>
 ${S.d.inactive.length ? `<div class="lbl">Vyradené deti</div><div class="card list" style="padding-block:4px">${S.d.inactive.map(k => `<div class="row"><span class="grow">${esc(k.name)} <span class="mute">${esc(cls(k.class_id).name)}</span></span><button class="btn ghost" data-a="archive" data-id="${k.id}" data-on="1">Vrátiť</button><button class="btn ghost" style="color:var(--ot)" data-a="delChild" data-id="${k.id}">Zmazať natrvalo</button></div>`).join('')}<div class="mute">Po odchode dieťaťa ho do 30 dní zmažte natrvalo (GDPR). Zmažú sa aj odhlásenia, správy a kontakty.</div></div>` : ''}`
}

V.board = () => {
  const k = myKid()
  if (!k) return `${logo()}<div class="card">Zatiaľ nemáte priradené dieťa. Ozvite sa, prosím, v škôlke.</div>`
  const ps = S.d.posts.filter(p => (!p.class_id || p.class_id == k.class_id) && (S.filter == 'all' || (S.filter == 'cls') == (p.class_id == k.class_id))).sort((a, b) => (b.pinned - a.pinned) || (b.id - a.id))
  return `${logo()}${kidChips()}${gaps().length ? `<div class="banner row sp" style="background:var(--o);color:var(--ot)"><span><b>Doplňte údaje:</b> ${gapText()}</span><button class="btn ghost" style="color:var(--ot);font-weight:700" data-a="go" data-v="wizard">Doplniť</button></div>` : ''}
 <section class="card row" style="flex-direction:row;background:var(--g);color:#fff;border:0">
  <div class="grow"><h2 style="font-size:19px;font-weight:600">${esc(first(k.name))} nepríde?</h2><div style="font-size:13px;color:var(--gb);margin-top:4px">Stravu na ${sk(NEXT)} odhlásite do ${DEADLINE}:00 v ten deň. Príchod do 8:00, potom sa budova zamyká.</div></div>
  <button class="btn" style="background:var(--card);color:var(--g)" data-a="go" data-v="absence">Odhlásiť</button></section>
 <div class="row sp"><h2 style="font-size:20px;font-weight:600">Nástenka</h2><div class="chips">${[['all', 'Všetko'], ['cls', cls(k.class_id).name], ['school', 'Celá MŠ']].map(([f, l]) => `<button class="chip ${S.filter == f ? 'on' : ''}" data-a="filter" data-f="${f}">${esc(l)}</button>`).join('')}</div></div>
 ${ps.map(post).join('') || '<p class="mute">Zatiaľ nič.</p>'}`
}

V.absence = () => {
  const staff = S.role != 'parent', k = byId(S.d.children, staff ? S.absKid : S.child), back = staff ? 'class' : 'board'
  if (!k) return `<button class="btn ghost" data-a="go" data-v="${back}">Späť</button>`
  S.form ??= { from: staff ? S.day : NEXT, to: staff ? S.day : NEXT, r: 'Choroba', note: '' }
  const f = S.form, ds = days(f.from, f.to), late = ds.filter(d => !mealOpen(d)).length, cal = (dt(f.to) - dt(f.from)) / 864e5 + 1
  const mine = S.d.absences.filter(a => a.child_id == k.id && a.date_to >= TODAY)
  return `${adminTabs()}<header class="row"><button class="btn ghost" aria-label="Späť" data-a="go" data-v="${back}">${ic('back')}</button><div><h1 style="font-size:22px">Odhlásiť dieťa</h1><div class="mute">${esc(k.name)} · ${esc(cls(k.class_id).name)}${staff ? ' · zapisuje škôlka' : ''}</div></div></header>
 <div class="banner" style="background:var(--o);color:var(--ot)"><b>Uzávierka:</b> strava sa odhlasuje najneskôr do ${DEADLINE}:00 v deň neprítomnosti. Potom sa platí v plnej výške.</div>
 <div class="grid2"><label class="f">Od<input type="date" data-c="from" ${staff ? '' : `min="${TODAY}"`} value="${f.from}"></label><label class="f">Do (vrátane)<input type="date" data-c="to" min="${f.from}" value="${f.to}"></label></div>
 <div class="f">Dôvod<div class="chips">${REASONS.map(r => `<button class="chip ${f.r == r ? 'on' : ''}" data-a="reason" data-r="${r}">${r}</button>`).join('')}</div></div>
 <label class="f">Poznámka pre učiteľku (nepovinné)<textarea rows="2" data-c="note">${esc(f.note)}</textarea></label>
 <div class="card"><div class="row sp"><span class="mute">Pracovné dni</span><b>${ds.length}</b></div><div class="row sp"><span class="mute">Strava</span><b style="color:${late ? 'var(--ot)' : 'var(--g)'}">${!ds.length ? '–' : late ? `${ds.length - late} dní odhlásených, ${late} po uzávierke` : 'odhlási sa automaticky'}</b></div></div>
 ${cal > 7 ? '<div class="banner" style="background:var(--b);color:var(--bt)">Neprítomnosť nad 7 dní: pri návrate treba <b>potvrdenie od lekára</b>.</div>' : cal >= 5 ? '<div class="banner" style="background:var(--b);color:var(--bt)">Po 5 a viac dňoch neprítomnosti treba pri návrate <b>vyhlásenie o bezinfekčnosti</b>.</div>' : ''}
 <button class="btn" data-a="submitAbs" ${ds.length ? '' : 'disabled'}>Odhlásiť ${esc(first(k.name))}</button>
 ${mine.length ? `<div class="lbl">Aktuálne odhlásenia</div>` + mine.map(a => `<div class="card row" style="flex-direction:row"><div class="grow"><b>${sk(a.date_from)}${a.date_to != a.date_from ? ' – ' + sk(a.date_to) : ''}</b> · ${esc(a.reason)}<div class="mute">${a.meals_from ? 'strava odhlásená od ' + sk(a.meals_from) : 'strava po uzávierke'}</div></div>${staff || a.date_from > TODAY || (a.date_from == TODAY && mealOpen(TODAY)) ? `<button class="btn ghost" data-a="cancelAbs" data-id="${a.id}">Zrušiť</button>` : ''}</div>`).join('') : ''}`
}

V.cal = () => {
  const c = S.role == 'parent' ? myKid()?.class_id : S.cls, m = S.d.menu.find(x => x.day == NEXT)
  const ev = S.d.posts.filter(p => p.event_date >= TODAY && (p.type == 'udalost' || p.type == 'prineste') && (!p.class_id || p.class_id == c)).sort((a, b) => a.event_date < b.event_date ? -1 : 1)
  return `${adminTabs()}<h1 style="font-size:26px">Kalendár</h1>${ev.map(e => `<div class="card row" style="flex-direction:row;gap:14px"><div style="width:56px;text-align:center"><div class="mute">${DN[dt(e.event_date).getDay()]}</div><div class="disp" style="font-size:18px">${dt(e.event_date).getDate()}. ${dt(e.event_date).getMonth() + 1}.</div></div><div><b>${esc(e.title)}</b><div class="mute">${TYPES[e.type]} · ${e.class_id ? esc(cls(e.class_id).name) : 'Celá MŠ'}</div></div></div>`).join('') || '<p class="mute">Žiadne udalosti.</p>'}
 <h2 style="font-size:20px;font-weight:600">Jedálniček · ${sk(NEXT)}</h2>${m ? `<div class="card list" style="padding-block:4px">${[['Desiata', m.snack], ['Obed', m.lunch], ['Olovrant', m.afternoon]].map(([l, x]) => `<div class="row"><b class="mute" style="width:78px">${l}</b><span class="grow">${esc(x)}</span></div>`).join('')}</div><div class="mute">Čísla = alergény (1–14).</div>` : '<p class="mute">Jedálniček ešte nie je zverejnený.</p>'}`
}

V.msg = () => {
  const staff = S.role != 'parent'
  if (staff && !S.thread) {
    const ks = kidsIn(S.cls).map(k => ({ k, last: S.d.msgs.find(m => m.child_id == k.id) })).sort((a, b) => (b.last?.created_at ?? '').localeCompare(a.last?.created_at ?? ''))
    return `${adminTabs()}<h1 style="font-size:24px">Správy · ${esc(cls(S.cls).name)}</h1><div class="chips">${S.d.classes.map(x => `<button class="chip ${x.id == S.cls ? 'on' : ''}" data-a="cls" data-id="${x.id}">${esc(x.name)}</button>`).join('')}</div><div class="card list" style="padding-block:4px">${ks.map(({ k, last }) => `<div><button class="btn ghost" style="width:100%;text-align:left;color:var(--ink)" data-a="thread" data-id="${k.id}"><b>${esc(k.name)}</b>${badge(unread(k.id))}<div class="mute">${last ? esc(last.body.slice(0, 60)) + ' · ' + time(last.created_at) : 'bez správ'}</div></button></div>`).join('') || '<div class="mute">V triede nie sú deti.</div>'}</div>`
  }
  const k = byId(S.d.children, staff ? S.thread : S.child)
  if (!k) return '<p class="mute">Nemáte priradené dieťa.</p>'
  const h = new Date().getHours() + new Date().getMinutes() / 60, quiet = h < 6.5 || h >= 17
  const ms = S.d.msgs.filter(m => m.child_id == k.id).reverse()
  return `${adminTabs()}<header class="row">${staff ? `<button class="btn ghost" aria-label="Späť" data-a="thread" data-id="">${ic('back')}</button>` : ''}<div><h1 style="font-size:20px">${staff ? esc(k.name) : 'Trieda ' + esc(cls(k.class_id).name)}</h1><div class="mute">${staff ? 'rodičia' : teachersOf(k.class_id).map(pname).map(esc).join(', ')}</div></div></header>
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
 <div class="card"><div class="lbl">Núdzové kontakty (v poradí pridania)</div>${S.d.emergency.filter(e => e.child_id == k.id).map((e, i) => `<div class="row"><div class="grow"><b>${i + 1}. ${esc(e.name)}</b> <span class="mute">${esc(e.relation)}</span><div><a href="${esc(tel(e.phone))}">${esc(phone(e.phone))}</a></div></div><button class="btn ghost" data-a="rmContact" data-id="${e.id}">Odstrániť</button></div>`).join('') || '<span class="mute">Zatiaľ žiadne. Pridajte aspoň jeden kontakt.</span>'}
  <form class="grid2" data-a="addContact" data-child="${k.id}"><input name="n" aria-label="Meno" placeholder="Meno" required><input name="r" aria-label="Vzťah" placeholder="Vzťah"><input name="p" type="tel" aria-label="Telefón" placeholder="Telefón (+421 9xx xxx xxx)" required style="grid-column:span 2"><button class="btn out" style="grid-column:span 2">Pridať kontakt</button></form></div>
 ${healthOn() ? (h => `<form class="card" data-a="saveHealth" data-child="${k.id}"><div class="lbl">Zdravie a strava</div>
  ${[['allergies', 'Alergie'], ['chronic', 'Chronické ochorenia'], ['medication', 'Lieky (len epilepsia/alergia, na písomný pokyn lekára)'], ['diet', 'Diéta pre kuchyňu (napr. bezlepková)']].map(([n, l]) => `<label class="f">${l}<textarea rows="2" name="${n}">${esc(h[n])}</textarea></label>`).join('')}
  <div class="mute">Vidia to učiteľky a vedenie. Kuchyňa vidí len počet diét v triede, bez mena.</div><button class="btn out">Uložiť</button></form>`)(S.d.health.find(x => x.child_id == k.id) ?? {})
    : lock('Zdravie a strava', 'Alergie, chronické ochorenia a diéty. Lieky MŠ nepodáva, výnimkou sú epilepsia a alergia na písomný pokyn lekára. Sprístupní sa po schválení spracúvania údajov škôlkou.')}
 <div class="card"><div class="lbl">Súhlasy</div><label class="row sp">Výlety mimo areálu MŠ<input type="checkbox" data-c="consent" data-child="${k.id}" ${trips?.granted ? 'checked' : ''}></label></div>
 <div class="card"><div class="lbl">Škôlka</div><div>J. Bánika 1733/41, Zvolen · prevádzka 6:30–17:00</div><div class="mute">Príchod do 8:00. Vyzdvihnutie pred spaním do 12:00, inak po 15:00.</div>
  <div class="row sp"><span>Trieda</span><a href="tel:+421908618373">+421 908 618 373</a></div><div class="row sp"><span>Strava (vedúca ŠJ)</span><a href="tel:+421917287956">+421 917 287 956</a></div><div class="row sp"><span>Riaditeľka · konzultácie 12:00–12:30</span><a href="tel:+421917287813">+421 917 287 813</a></div></div>`
}

V.class = () => {
  const c = cls(S.cls), rows = kidsIn(S.cls).map(k => ({ k, ...status(k.id, S.day) })), n = s => rows.filter(r => r.s == s).length
  const subs = S.d.staff.filter(x => x.substitute_id == S.me.id && x.day == S.day)
  const tile = (v, l, o) => `<div class="card" style="gap:2px;${o ? 'background:var(--o);border-color:var(--ob);color:var(--ot)' : ''}"><div class="disp" style="font-size:26px">${v}</div><div style="font-size:12px;font-weight:600">${l}</div></div>`
  return `${adminTabs()}<header class="row sp" style="align-items:flex-end"><div><div class="mute" style="font-weight:600">${sk(S.day)}${S.day != TODAY ? ' · oprava dochádzky' : ''}</div><h1 style="font-size:28px">${esc(c.name)}</h1></div><label><span class="sr">Deň</span><input type="date" data-c="day" max="${TODAY}" value="${S.day}" style="width:auto;min-height:40px;padding:6px 10px"></label></header>
 <div class="chips">${S.d.classes.map(x => `<button class="chip ${x.id == S.cls ? 'on' : ''}" data-a="cls" data-id="${x.id}">${esc(x.name)}</button>`).join('')}</div>
 ${subs.map(x => `<div class="banner" style="background:var(--b);color:var(--bt)"><b>Záskok:</b> trieda ${esc(classOf(x.teacher_id).name)} za ${esc(pname(x.teacher_id))}.</div>`).join('')}
 <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px">${tile(n('ok') + '/' + rows.length, 'prítomní')}${tile(n('abs'), 'odhlásení')}${tile(n('miss'), 'neohlásení', n('miss'))}</div>
 <div class="card list" style="padding-block:4px">${rows.map(r => { const ps = S.d.pickups.filter(p => p.child_id == r.k.id), es = S.d.emergency.filter(e => e.child_id == r.k.id), h = S.d.health.find(x => x.child_id == r.k.id)
    const hasHealth = h && (h.allergies || h.chronic || h.medication || h.diet)
    return `<div><div class="row"><div class="grow"><b>${esc(r.k.name)}</b>${hasHealth ? ' <span class="pill o">zdravie</span>' : ''}
   ${r.s == 'abs' ? `<div class="mute">${esc(r.a.reason)} · do ${sk(r.a.date_to)}${r.a.note ? ' · ' + esc(r.a.note) : ''}</div>` : ''}
   ${ps.filter(p => p.authorized).length ? `<div class="mute" style="color:var(--bt)">môže vyzdvihnúť aj: ${ps.filter(p => p.authorized).map(p => esc(p.name)).join(', ')}</div>` : ''}
   ${ps.filter(p => !p.authorized).map(p => `<button class="btn ghost" style="font-size:13px" data-a="authorize" data-id="${p.id}">Potvrdiť splnomocnenie: ${esc(p.name)}</button>`).join('')}</div>
   ${r.s == 'abs' ? '<span class="pill">Odhlásený</span>' : r.s == 'miss' ? `<button class="btn ghost" style="color:var(--ot)" data-a="thread" data-id="${r.k.id}" data-go="msg">Kontaktovať</button><button class="pill o" data-a="toggleAtt" data-id="${r.k.id}">Chýba</button>` : `<button class="pill g" data-a="toggleAtt" data-id="${r.k.id}">Prítomný</button>`}</div>
   <details><summary class="mute" style="cursor:pointer;padding:6px 0">Kontakty${hasHealth ? ', zdravie' : ''} a odhlásenie</summary><div style="display:flex;flex-direction:column;gap:6px;padding:4px 0 6px">
    ${es.map((e, i) => `<div>${i + 1}. ${esc(e.name)} <span class="mute">${esc(e.relation)}</span> · <a href="${esc(tel(e.phone))}">${esc(phone(e.phone))}</a></div>`).join('') || '<div class="mute">Rodič nezadal núdzové kontakty.</div>'}
    ${hasHealth ? [['Alergie', h.allergies], ['Ochorenia', h.chronic], ['Lieky', h.medication], ['Diéta', h.diet]].filter(x => x[1]).map(([l, v]) => `<div><b>${l}:</b> ${esc(v)}</div>`).join('') : ''}
    <button class="btn out" style="align-self:flex-start" data-a="absFor" data-id="${r.k.id}">Zapísať odhlásenie (volal rodič)</button></div></details></div>` }).join('') || '<div class="mute">V triede nie sú deti.</div>'}</div>
 <div class="mute">Ťuknutím prepnete Prítomný / Chýba. Ukladá sa hneď.</div>`
}

V.posts = () => {
  const d = S.draft ??= { scope: S.cls ?? 'all', type: 'oznam', title: '', text: '', opts: '', date: NEXT, req: true, pin: false }
  const scopes = [...S.d.classes.map(c => [c.id, c.name]), ['all', 'Celá MŠ']]
  return `${adminTabs()}<h1 style="font-size:24px">${d.id ? 'Upraviť oznam' : 'Nový oznam'}</h1><form class="card" data-a="publish">
  <div class="f">Komu<div class="chips">${scopes.map(([v, l]) => `<button type="button" class="chip ${d.scope == v ? 'on' : ''}" data-a="draft" data-k="scope" data-val="${v}">${esc(l)}</button>`).join('')}</div></div>
  <div class="f">Typ<div class="chips">${Object.entries(TYPES).map(([v, l]) => `<button type="button" class="chip ${d.type == v ? 'on' : ''}" data-a="draft" data-k="type" data-val="${v}">${l}</button>`).join('')}</div></div>
  <label class="f">Nadpis<input data-d="title" value="${esc(d.title)}" required maxlength="120"></label>
  <label class="f">Text<textarea rows="3" data-d="text">${esc(d.text)}</textarea></label>
  ${d.type == 'anketa' ? `<label class="f">Možnosti (každá na nový riadok)<textarea rows="3" data-d="opts" required>${esc(d.opts)}</textarea></label>` : ''}
  ${d.type == 'udalost' || d.type == 'prineste' ? `<label class="f">${d.type == 'udalost' ? 'Dátum' : 'Prineste do'}<input type="date" data-d="date" min="${TODAY}" value="${d.date}" required></label>` : ''}
  ${[['req', 'Vyžadovať potvrdenie prečítania'], ['pin', 'Pripnúť na vrch']].map(([k, l]) => `<label class="row sp">${l}<input type="checkbox" data-d="${k}" ${d[k] ? 'checked' : ''}></label>`).join('')}
  ${d.id ? `<div class="row"><button class="btn">Uložiť zmeny</button><button type="button" class="btn ghost" data-a="cancelEdit">Zrušiť úpravu</button></div><div class="mute">Úprava už neposiela nové upozornenie.</div>` : `<button class="btn">Zverejniť ${parentsIn(d.scope == 'all' ? null : d.scope).length} rodičom</button>`}</form>
 <div class="lbl">Zverejnené oznamy</div>
 ${S.d.posts.map(p => { const all = parentsIn(p.class_id), rd = readBy(p), un = all.filter(u => !rd.includes(u)), mine = p.author_id == S.me.id || S.role == 'admin'
    return `<div class="card"><div class="row sp" style="align-items:flex-start"><div><b>${esc(p.title)}</b><div class="mute">${TYPES[p.type]} · ${p.class_id ? esc(cls(p.class_id).name) : 'Celá MŠ'} · ${esc(pname(p.author_id))} · ${sk(p.created_at.slice(0, 10))}</div></div>
    ${mine ? `<div class="row" style="gap:4px"><button class="btn ghost" data-a="editPost" data-id="${p.id}">Upraviť</button><button class="btn ghost" style="color:var(--ot)" data-a="delPost" data-id="${p.id}">Zmazať</button></div>` : ''}</div>
    ${p.require_read ? `<div class="row sp"><span class="mute">Prečítali</span><span class="mute">${all.length - un.length} z ${all.length}</span></div><div style="height:8px;border-radius:4px;background:var(--line2)"><div style="height:8px;border-radius:4px;background:var(--g);width:${all.length ? (all.length - un.length) / all.length * 100 : 0}%"></div></div>${un.length ? `<details><summary class="mute">Neprečítali (${un.length})</summary><div class="mute">${un.map(pname).map(esc).join(', ')}</div></details>` : ''}` : ''}</div>` }).join('') || '<p class="mute">Zatiaľ žiadne oznamy.</p>'}`
}

V.over = () => adminTabs() + `<h1 style="font-size:28px">Prehľad · ${sk(TODAY)}</h1><div class="cols">${S.d.classes.map(c => { const ss = kidsIn(c.id).map(k => status(k.id, TODAY).s), cnt = s => ss.filter(x => x == s).length
  return `<div class="card"><div class="row sp"><b style="font-size:17px">${esc(c.name)}</b>${cnt('miss') ? `<span class="pill o">${cnt('miss')} neohlásené</span>` : ''}</div><div class="disp" style="font-size:32px;color:var(--g)">${cnt('ok')}<span class="mute" style="font-size:16px"> / ${ss.length} prítomných</span></div><div class="mute">${cnt('abs')} odhlásené · ${teachersOf(c.id).map(t => esc(pname(t)) + (S.d.staff.some(x => x.teacher_id == t && x.day == TODAY) ? ' (nie je)' : '')).join(', ')}</div></div>` }).join('')}</div>
 <div class="card"><div class="lbl">Na vyriešenie</div>${todo()}</div>`

V.staff = () => {
  const wk = [0, 1, 2, 3, 4].map(i => add(MON, i)), ts = teachers()
  const subFor = (t, d) => S.d.staff.filter(x => x.substitute_id == t && x.day == d).map(x => ' + ' + esc(classOf(x.teacher_id).name)).join('')
  return adminTabs() + `<h1 style="font-size:28px">Personál · týždeň od ${sk(MON)}</h1><div class="card" style="overflow-x:auto"><table><tr><th>Učiteľka</th>${wk.map(d => `<th>${sk(d)}</th>`).join('')}</tr>
 ${ts.map(t => `<tr><td><b>${esc(t.full_name || t.email)}</b><select aria-label="Trieda" data-c="tcls" data-t="${t.id}" style="margin-top:6px;min-height:38px;padding:4px 8px;font-size:13px"><option value="">– bez triedy –</option>${S.d.classes.map(c => `<option value="${c.id}" ${S.d.ct.some(x => x.teacher_id == t.id && x.class_id == c.id) ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></td>${wk.map(d => { const a = S.d.staff.find(x => x.teacher_id == t.id && x.day == d)
    return `<td style="min-width:130px">${a
      ? `<button class="cell abs" data-a="staff" data-t="${t.id}" data-d="${d}">Neprítomná</button><select aria-label="Záskok" data-c="sub" data-t="${t.id}" data-d="${d}" style="margin-top:6px;min-height:38px;padding:4px 8px;font-size:13px"><option value="">– záskok –</option>${ts.filter(x => x.id != t.id && !S.d.staff.some(y => y.teacher_id == x.id && y.day == d)).map(x => `<option value="${x.id}" ${a.substitute_id == x.id ? 'selected' : ''}>${esc(x.full_name || x.email)}</option>`).join('')}</select>`
      : `<button class="cell" data-a="staff" data-t="${t.id}" data-d="${d}">${esc(classOf(t.id).name)}${subFor(t.id, d)}</button>`}</td>` }).join('')}</tr>`).join('')}</table>
 <div class="mute">Klik na bunku = neprítomnosť. Dôvod sa neeviduje, len trvanie.</div></div><div class="card"><div class="lbl">Na vyriešenie</div>${todo()}</div>`
}

V.report = () => {
  const month = S.repMonth + '-01', last = iso(new Date(dt(month).getFullYear(), dt(month).getMonth() + 1, 0))
  const wd = days(month, last).filter(d => d <= TODAY)
  const months = Array.from({ length: 12 }, (_, i) => iso(new Date(dt(TODAY).getFullYear(), dt(TODAY).getMonth() - i, 1)).slice(0, 7))
  S.rep = S.d.children.map(k => [cls(k.class_id).name, k.name, wd.length, wd.filter(d => status(k.id, d).s != 'ok').length])
  return adminTabs() + `<div class="row sp" style="flex-wrap:wrap"><h1 style="font-size:28px">Výkaz dochádzky</h1><div class="row"><select aria-label="Mesiac" data-c="repm" style="width:auto">${months.map(m => `<option value="${m}" ${m == S.repMonth ? 'selected' : ''}>${dt(m + '-01').toLocaleDateString('sk', { month: 'long', year: 'numeric' })}</option>`).join('')}</select><button class="btn" data-a="csv">Stiahnuť CSV</button></div></div>
 <div class="card" style="overflow-x:auto"><table><tr><th>Trieda</th><th>Dieťa</th><th class="n">Prac. dni</th><th class="n">Neprítomný</th><th class="n">Prítomný</th></tr>${S.rep.map(r => `<tr><td>${esc(r[0])}</td><td>${esc(r[1])}</td><td class="n">${r[2]}</td><td class="n">${r[3]}</td><td class="n">${r[2] - r[3]}</td></tr>`).join('')}</table>
 <div class="mute">Do dnešného dňa. Neprítomnosť = odhlásenie alebo „Chýba“ v dochádzke.</div></div>`
}

V.kitchen = () => {
  const open = mealOpen(KITCHEN_DAY), tot = S.d.meals.reduce((s, c) => s + c.portions, 0)
  const wk = [0, 1, 2, 3, 4].map(i => add(MON, i + S.week * 7))
  return `${S.role == 'admin' ? adminTabs() : logo()}<div class="row sp" style="flex-wrap:wrap"><h1 style="font-size:28px">Porcie na ${sk(KITCHEN_DAY)}</h1><span class="pill ${open ? 'o' : 'g'}" style="font-size:14px;padding:8px 12px">${open ? `Uzávierka ${DEADLINE}:00 · počty sa ešte menia` : `Uzavreté o ${DEADLINE}:00 · počty sú finálne`}</span></div>
 <div class="cols"><div class="card"><table><tr><th>Trieda</th><th class="n">Porcie</th></tr>${S.d.meals.map(c => `<tr><td><b>${esc(c.class_name)}</b></td><td class="n" style="font-size:18px">${c.portions}</td></tr>`).join('')}<tr><td class="disp" style="font-size:18px">Spolu</td><td class="n disp" style="font-size:24px;color:var(--g)">${tot}</td></tr></table><button class="btn ghost" style="align-self:flex-start" data-a="refresh">Obnoviť</button></div>
 ${healthOn() ? `<div class="card"><div class="lbl">Diéty (bez mien)</div>${S.d.diets.map(x => `<div class="row sp"><span>${esc(x.class_name)} · ${esc(x.diet)}</span><b>${x.n}</b></div>`).join('') || '<span class="mute">Žiadne diéty.</span>'}</div>` : lock('Diéty a alergie', 'Po schválení tu kuchyňa uvidí počty diétnych porcií podľa triedy, bez kontaktov na rodičov.')}</div>
 <form class="card" data-a="saveMenu" style="overflow-x:auto"><div class="row sp" style="flex-wrap:wrap"><div class="lbl">Jedálny lístok · týždeň od ${sk(wk[0])}</div><div class="chips">${['Tento týždeň', 'Budúci týždeň'].map((l, i) => `<button type="button" class="chip ${S.week == i ? 'on' : ''}" data-a="week" data-i="${i}">${l}</button>`).join('')}</div></div>
 <table><tr><th>Deň</th><th>Desiata</th><th>Obed</th><th>Olovrant</th></tr>${wk.map(d => { const m = S.d.menu.find(x => x.day == d) ?? {}
    return `<tr><td><b>${sk(d)}</b></td>${['snack', 'lunch', 'afternoon'].map(k => `<td><input name="${d}|${k}" aria-label="${sk(d)} ${k}" value="${esc(m[k])}"></td>`).join('')}</tr>` }).join('')}</table>
 <div class="row sp"><span class="mute">Alergény píšte do zátvorky, napr. (1, 7).</span><button class="btn">Uložiť a zverejniť</button></div></form>`
}

// ---------- akcie ----------
const A = {
  go: d => { S.v = d.v; scrollTo(0, 0) },
  menu: () => { S.menu = !S.menu; S.bell = false },
  bell: () => { S.bell = !S.bell; S.menu = false },
  theme: d => window.theme?.set(d.m),
  note: async d => {
    const n = byId(S.d.notes, d.id); if (!n) return
    if (!n.read_at) await q(sb.from('notifications').update({ read_at: new Date().toISOString() }).eq('id', n.id))
    if (n.kind == 'message' && n.child_id) { if (S.role == 'parent') S.child = n.child_id; else S.thread = n.child_id; S.v = 'msg' }
    else if (n.kind == 'absence' && n.child_id) { S.cls = byId(S.d.children, n.child_id)?.class_id ?? S.cls; S.v = 'class' }
    else if (n.kind == 'reminder') { S.child = n.child_id ?? S.child; S.v = 'absence' }
    else if (n.kind == 'post') S.v = S.role == 'parent' ? 'board' : 'posts'
    scrollTo(0, 0)
  },
  notesRead: async () => { await q(sb.from('notifications').update({ read_at: new Date().toISOString() }).eq('user_id', S.me.id).is('read_at', null)) },
  testPush: async () => { await q(sb.rpc('send_test')); toast('Skúšobné upozornenie odoslané') },
  filter: d => { S.filter = d.f },
  child: d => { S.child = +d.id; S.form = null },
  cls: d => { S.cls = +d.id; S.draft = null },
  thread: d => { S.thread = d.id ? +d.id : null; if (d.go) S.v = d.go },
  week: d => { S.week = +d.i },
  mode: () => { S.reg = !S.reg; S.forgot = false },
  forgotMode: () => { S.forgot = !S.forgot; S.reg = false },
  cancelEdit: () => { S.draft = null },
  absFor: d => { S.absKid = +d.id; S.form = null; S.v = 'absence' },
  block: async d => {
    if (d.on && !confirm('Naozaj? Používateľ stratí prístup.')) return
    await q(sb.from('profiles').update({ blocked: !!d.on }).eq('id', d.id)); toast(d.on ? 'Prístup zrušený' : 'Obnovené')
  },
  unlink: async d => { await q(sb.from('guardians').delete().eq('child_id', d.child).eq('parent_id', d.p)) },
  archive: async d => { await q(sb.from('children').update({ active: !!d.on }).eq('id', d.id)); toast(d.on ? 'Dieťa vrátené' : 'Dieťa vyradené') },
  delChild: async d => { if (confirm('Zmazať dieťa natrvalo aj so všetkými záznamami?')) await q(sb.from('children').delete().eq('id', d.id)) },
  editPost: d => {
    const p = byId(S.d.posts, d.id)
    S.draft = { id: p.id, scope: p.class_id ?? 'all', type: p.type, title: p.title, text: p.body, opts: (p.poll_options ?? []).join('\n'), date: p.event_date ?? NEXT, req: p.require_read, pin: p.pinned }
    scrollTo(0, 0)
  },
  delPost: async d => { if (confirm('Zmazať oznam?')) { await q(sb.from('posts').delete().eq('id', d.id)); toast('Oznam zmazaný') } },
  rmContact: async d => { await q(sb.from('emergency_contacts').delete().eq('id', d.id)) },
  recheck: () => boot(),
  refresh: () => {}, // run() po akcii dáta aj tak znovu načíta
  logout: () => sb.auth.signOut(),
  push: () => enablePush(),
  install: async () => { installEvent.prompt(); await installEvent.userChoice; installEvent = null; showInstall() },
  dismissInstall: () => { try { localStorage.setItem('installDismissed', Date.now()) } catch {} ; showInstall() },
  confirm: async d => { await q(sb.from('post_reads').insert({ post_id: d.id })); toast('Potvrdené') },
  vote: async d => { await q(sb.from('poll_votes').insert({ post_id: d.id, choice: +d.i })) },
  reason: d => { S.form.r = d.r },
  submitAbs: async () => {
    const f = S.form, staff = S.role != 'parent', k = byId(S.d.children, staff ? S.absKid : S.child)
    const a = await q(sb.from('absences').insert({ child_id: k.id, date_from: f.from, date_to: f.to, reason: f.r, note: f.note }).select().single())
    S.form = null; S.v = staff ? 'class' : 'board'
    toast(a.meals_from ? `Odhlásené · strava od ${sk(a.meals_from)}` : 'Odhlásené · strava už po uzávierke')
  },
  cancelAbs: async d => { await q(sb.from('absences').delete().eq('id', d.id)); toast('Odhlásenie zrušené') },
  toggleAtt: async d => {
    const k = +d.id
    if (status(k, S.day).s == 'miss') await q(sb.from('attendance').delete().eq('child_id', k).eq('day', S.day))
    else await q(sb.from('attendance').insert({ child_id: k, day: S.day }))
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
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['﻿' + t], { type: 'text/csv' })); a.download = `dochadzka-${S.repMonth}.csv`; a.click()
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
  forgot: async fd => {
    const { error } = await sb.auth.resetPasswordForEmail(fd.email.trim(), { redirectTo: location.origin + location.pathname })
    if (error) throw error
    S.forgot = false; toast('Ak e-mail existuje, poslali sme odkaz na nové heslo.')
  },
  setPassword: async fd => {
    if (fd.p1 != fd.p2) throw new Error('Heslá sa nezhodujú.')
    const { error } = await sb.auth.updateUser({ password: fd.p1 })
    if (error) throw error
    S.recovery = false; S.v = S.me.approved ? DEF[S.role] : 'pending'; toast('Heslo zmenené')
  },
  addContact: async (fd, f) => { await q(sb.from('emergency_contacts').insert({ child_id: +f.dataset.child, name: fd.n.trim(), relation: fd.r.trim(), phone: phone(fd.p) })) },
  saveHealth: async (fd, f) => { await q(sb.from('child_health').upsert({ child_id: +f.dataset.child, ...fd, updated_at: new Date().toISOString() })); toast('Uložené') },
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
    const d = S.draft, row = { class_id: d.scope == 'all' ? null : +d.scope, type: d.type, title: d.title.trim(), body: d.text.trim(), require_read: d.req, pinned: d.pin, poll_options: null, event_date: null }
    if (d.type == 'anketa') { row.poll_options = d.opts.split('\n').map(s => s.trim()).filter(Boolean); if (row.poll_options.length < 2) throw new Error('Anketa potrebuje aspoň 2 možnosti.') }
    if (d.type == 'udalost' || d.type == 'prineste') row.event_date = d.date
    if (d.id) { await q(sb.from('posts').update(row).eq('id', d.id)); S.draft = null; return toast('Oznam upravený') }
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
  // realtime obnova nesmie zmazať rozpísaný text: zapamätáme si pole s kurzorom
  const f = document.activeElement, key = f?.name || f?.dataset?.c || f?.dataset?.d, val = f?.value, form = f?.form?.dataset?.a
  if (S.role == 'parent' && S.me.approved && !S.wizChecked && S.d.children) {   // po prihlásení otvoríme sprievodcu, ak niečo chýba
    S.wizChecked = true
    const g = gaps()[0]; if (g) { S.child = g[0].id; S.v = 'wizard' }
  }
  const view = S.recovery ? 'password' : S.me.approved || S.v == 'password' ? S.v : 'pending'
  const wide = S.role == 'admin' && !['posts', 'class', 'msg', 'cal', 'absence', 'password', 'settings'].includes(view) || S.role == 'kitchen' && !['password', 'settings'].includes(view)
  app.className = wide ? 'wide' : ''
  bar.className = wide ? 'wide' : ''
  app.innerHTML = V[view]()
  if (key && val && f.type != 'checkbox') {
    const el = [...app.querySelectorAll(`[name="${key}"],[data-c="${key}"],[data-d="${key}"]`)]
      .find(e => (e.form?.dataset?.a ?? form) == form && e.dataset.id == f.dataset.id && (e.form?.dataset?.child ?? e.dataset.child) == (f.form?.dataset?.child ?? f.dataset.child))
    if (el && el.type != 'date' && el.tagName != 'SELECT') { el.value = val; el.focus() }
  }
  const n = unreadAll()
  const cnt = unseen(), pop = S.bell ? `<div class="pop"><div class="row sp"><b>Upozornenia</b>${cnt ? '<button class="btn ghost" data-a="notesRead">Označiť všetko</button>' : ''}</div>
    ${S.d.notes?.length ? S.d.notes.map(x => `<button class="note ${x.read_at ? '' : 'new'}" data-a="note" data-id="${x.id}"><b>${esc(x.title)}</b>${x.body ? `<span>${esc(x.body)}</span>` : ''}<small>${time(x.created_at)}</small></button>`).join('') : '<div class="mute" style="padding:10px 0">Zatiaľ nič nové.</div>'}
    <button class="btn ghost" data-a="go" data-v="settings">Nastavenia upozornení</button></div>`
    : S.menu ? `<div class="pop"><div class="mute" style="padding-bottom:6px">${esc(S.me.email)} · ${ROLE[S.role]}</div>
    ${S.me.approved ? '<button data-a="go" data-v="settings">Nastavenie upozornení</button>' : ''}
    <div class="lbl" style="padding:8px 0 4px">Vzhľad</div><div class="chips">${THEMES.map(([m, l]) => `<button class="chip ${window.theme?.get() == m ? 'on' : ''}" data-a="theme" data-m="${m}">${l}</button>`).join('')}</div>
    <button data-a="go" data-v="password">Zmeniť heslo</button><button data-a="logout">Odhlásiť sa</button></div>` : ''
  bar.innerHTML = `<div class="bi"><span style="margin-right:auto"><b>${esc(S.me.full_name || S.me.email)}</b> · ${ROLE[S.role]}</span>${S.me.approved ? `<button class="bell" data-a="bell" aria-label="Upozornenia">${ic('bell')}${cnt ? `<i>${cnt}</i>` : ''}</button>` : ''}<button data-a="menu" aria-haspopup="true" aria-expanded="${S.menu}">Menu ▾</button></div>${pop}`
  try { navigator.setAppBadge?.(cnt) } catch { }
  nav.hidden = !TABS[S.role] || S.role == 'admin' || !S.me.approved
  if (!nav.hidden) nav.innerHTML = TABS[S.role].map(([v, l, i]) => `<button data-a="go" data-v="${v}" class="${S.v == v ? 'on' : ''}">${ic(i)}${l}${v == 'msg' && n ? ` (${n})` : ''}</button>`).join('')
}

// Po každej zmene načítame dáta znovu. Zmeny od iných prídu cez realtime (viď boot).
async function run(fn, local) {
  try { await fn(); if (!local && S.me?.approved) await load() } catch (e) { console.error(e); toast(e.message || 'Niečo sa nepodarilo.') }
  render()
}
const LOCAL = ['menu', 'bell', 'theme']   // len prekreslia, dáta netreba znovu načítať
document.addEventListener('click', e => {
  const b = e.target.closest('[data-a]')
  if (!b) { if ((S.menu || S.bell) && !e.target.closest('.pop')) { S.menu = S.bell = false; render() } return }
  if (b.tagName == 'FORM') return
  const a = b.dataset.a
  if (a != 'theme') { if (a != 'menu') S.menu = false; if (a != 'bell') S.bell = false }
  run(() => A[a](b.dataset), LOCAL.includes(a))
})
document.addEventListener('submit', e => { e.preventDefault(); const f = e.target; run(async () => { await F[f.dataset.a](Object.fromEntries(new FormData(f)), f); f.reset() }) })
document.addEventListener('input', e => { const el = e.target; if (el.dataset.c == 'note') S.form.note = el.value; if (el.dataset.d && el.type != 'checkbox' && el.type != 'date') S.draft[el.dataset.d] = el.value })
document.addEventListener('change', e => {
  const el = e.target, c = el.dataset.c
  if ((c == 'from' || c == 'to') && el.value) { S.form[c] = el.value; if (S.form.to < S.form.from) S.form.to = S.form.from; render() }
  if (c == 'pref') run(() => q(sb.from('notification_prefs').upsert({ user_id: S.me.id, [el.dataset.k]: el.checked })))
  if (c == 'consent') run(() => q(sb.from('consents').upsert({ child_id: +el.dataset.child, kind: 'vylety', granted: el.checked, updated_at: new Date().toISOString() })))
  if (c == 'sub') run(() => q(sb.from('staff_absences').update({ substitute_id: el.value || null }).eq('teacher_id', el.dataset.t).eq('day', el.dataset.d)))
  if (c == 'tcls') run(async () => {   // učiteľka má jednu triedu
    await q(sb.from('class_teachers').delete().eq('teacher_id', el.dataset.t))
    if (el.value) await q(sb.from('class_teachers').insert({ class_id: +el.value, teacher_id: el.dataset.t }))
    toast('Trieda priradená')
  })
  const since = d => { if (d < S.since) S.since = d.slice(0, 8) + '01' }   // staršie dáta dotiahneme, až keď treba
  if (c == 'day' && el.value) { S.day = el.value > TODAY ? TODAY : el.value; since(S.day); run(() => {}) }
  if (c == 'repm') { S.repMonth = el.value; since(el.value + '-01'); run(() => {}) }
  if (c == 'role') run(async () => { await q(sb.from('profiles').update({ role: el.value }).eq('id', el.dataset.id)); toast('Rola zmenená') })
  if (c == 'kname' && el.value.trim()) run(async () => { await q(sb.from('children').update({ name: el.value.trim() }).eq('id', el.dataset.id)); toast('Uložené') })
  if (c == 'kcls') run(async () => { await q(sb.from('children').update({ class_id: +el.value }).eq('id', el.dataset.id)); toast('Dieťa presunuté') })
  if (c == 'link' && el.value) run(async () => { await q(sb.from('guardians').insert({ child_id: +el.dataset.child, parent_id: el.value })); toast('Rodič priradený') })
  if (el.dataset.d) S.draft[el.dataset.d] = el.type == 'checkbox' ? el.checked : el.value
})
document.addEventListener('visibilitychange', () => { if (!document.hidden && S.me) run(() => {}) })
sb.auth.onAuthStateChange(ev => {
  if (ev == 'SIGNED_OUT') location.reload()
  if (ev == 'PASSWORD_RECOVERY') { S.recovery = true; run(boot) }   // návrat z odkazu „zabudnuté heslo“
})

// Realtime: zmeny od iných (správy, oznamy, odhlásenia, dochádzka) obnovia obrazovku. RLS platí aj tu.
let rt, rtTimer
function realtime() {
  if (rt) return
  rt = sb.channel('zmeny')
  for (const table of ['messages', 'posts', 'absences', 'attendance'])
    rt.on('postgres_changes', { event: '*', schema: 'public', table }, () => { clearTimeout(rtTimer); rtTimer = setTimeout(() => run(() => {}), 400) })
  rt.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications' }, p => { if (!document.hidden) toast(p.new.title); clearTimeout(rtTimer); rtTimer = setTimeout(() => run(() => {}), 400) })
  rt.subscribe()
}

// ---------- inštalácia na plochu ----------
// Android (Chrome, Samsung, Edge): vlastné tlačidlo spustí systémové okno „Inštalovať“.
// iPhone/iPad: automaticky to nejde (Apple to nedovolí), preto zobrazíme návod na „Pridať na plochu“.
let installEvent = null
const ua = navigator.userAgent
const isIos = /iphone|ipad|ipod/i.test(ua) || (navigator.platform == 'MacIntel' && navigator.maxTouchPoints > 1)
const inAppBrowser = /FBAN|FBAV|Instagram|Messenger|WhatsApp|Line\//i.test(ua)
const installed = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone
const dismissed = () => { try { return Date.now() - (+localStorage.getItem('installDismissed') || 0) < 7 * 864e5 } catch { return false } }
const shareIcon = '<svg class="ic" viewBox="0 0 24 24" aria-label="Zdieľať"><path d="M12 3v12M8 7l4-4 4 4"/><path d="M6 11v9h12v-9"/></svg>'
function showInstall() {
  const b = document.getElementById('install'), close = '<button class="btn ghost" data-a="dismissInstall" aria-label="Zavrieť">×</button>'
  const html = installed() || dismissed() ? ''
    : inAppBrowser ? `<span class="grow">Pre inštaláciu otvorte túto stránku v ${isIos ? 'Safari' : 'Chrome'} (menu ⋯ → Otvoriť v prehliadači).</span>${close}`
    : installEvent ? `<span class="grow"><b>Nainštalujte si Ďatelinku</b> na plochu. Dostanete upozornenia na nové oznamy a správy od učiteliek a otvorí sa jedným ťuknutím.</span><button class="btn" data-a="install">Nainštalovať</button>${close}`
    : isIos ? `<span class="grow"><b>Pridajte si Ďatelinku na plochu, aby vám chodili upozornenia</b> na oznamy a správy (na iPhone bez toho nefungujú). Ťuknite na ${shareIcon} Zdieľať a potom <b>Pridať na plochu</b>.</span>${close}`
    : ''
  b.innerHTML = html; b.hidden = !html
}
addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvent = e; showInstall() })
addEventListener('appinstalled', () => { installEvent = null; showInstall(); toast('Ďatelinka je na ploche') })
showInstall()

async function boot() {
  const { data: { session } } = await sb.auth.getSession()
  if (!session) return
  S.me = await q(sb.from('profiles').select('*').eq('id', session.user.id).single())
  S.role = S.me.role; S.v = S.me.approved && !S.me.blocked ? (S.v && S.v != 'pending' ? S.v : DEF[S.role]) : 'pending'
  if (S.me.blocked) S.me.approved = false
  if (S.me.approved) realtime()
  const reg = await navigator.serviceWorker?.register('sw.js').catch(() => null)
  S.push = !!(await reg?.pushManager?.getSubscription())
}
run(boot)
