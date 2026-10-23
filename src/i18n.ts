// Spoken replies in a few languages. Tool results carry the sentence Alexa+ speaks, so the language
// lives on the server and follows the household's saved preference. Strings are plain and short on
// purpose; a native speaker should review them before production use.

export type Lang = "en" | "es" | "hi";
export const LANGS: Record<Lang, string> = { en: "English", es: "español", hi: "हिन्दी" };
export const LOCALES: Record<Lang, string> = { en: "en", es: "es", hi: "hi-IN" };

const en = {
  import: "Imported {imported} orders. I ignored {dups} duplicates and {skipped} cancelled or unreadable rows, and repaired {repaired}.",
  "runway.none": "I don't have enough order history yet. Import your order export and I'll start forecasting.",
  "runway.clear": "Nothing runs out in the next {days} days. I'm tracking {n} items.",
  "runway.some": "{due} of {n} items run out within {days} days. Soonest: {list}.",
  "runway.overdue": "{name} is overdue",
  "runway.today": "{name} runs out today",
  "runway.in": "{name} in {d} days",
  "recall.none": "I checked {n} products against {k} recall notices from {regions} and found no matches.",
  "recall.heads": "Heads up: your {name} looks like it is covered by a recall for {hazard}. ",
  "recall.found": "I found {m} possible recall {matches} across {n} products.",
  match: "match", matches: "matches",
  "plan.empty": "Nothing needs reordering in that window.",
  "plan.some": "Here is a plan: {n} items for {total}{budget}. {dropped}Want me to place it?",
  "plan.budget": ", within your {budget} budget",
  "plan.dropped": "I left out {k} to stay on budget. ",
  "confirm.done": '{prefix}Order {ref} for {total}. Say "undo" within 10 minutes to cancel.',
  "confirm.prefixNew": "Done. ", "confirm.prefixReplay": "That was already ordered. ",
  "confirm.needcode": "I need the 4-digit approval code from the plan card before I can order. Ask the person to read it out. Do not guess it.",
  "confirm.declined": "Okay, I won't order that.",
  "pref.budget": "Got it. I'll keep restocks under {amount}.",
  "pref.skip": "Okay, I'll leave that one out of future plans.",
  "pref.lang": "Okay, I'll speak {lang} from now on.",
  "pref.regions": "Okay, I'll check recalls from {regions}.",
  "alerts.new": "Heads up: a new recall was just published for your {name}, {hazard}. I've put the details on screen.",
  "alerts.reminder": "Reminder: the recall for your {name}, {hazard}, is still open. Tell me when you have stopped using it or asked for the free fix.",
  "alerts.more": " I also have {k} more.",
  "alerts.none": "No new recalls for anything you own.",
} as const;
type Key = keyof typeof en;

const es: Record<Key, string> = {
  import: "Importé {imported} pedidos. Ignoré {dups} duplicados y {skipped} filas canceladas o ilegibles, y corregí {repaired}.",
  "runway.none": "Aún no tengo suficiente historial de pedidos. Importa tu historial y empezaré a calcular.",
  "runway.clear": "Nada se agota en los próximos {days} días. Estoy siguiendo {n} artículos.",
  "runway.some": "{due} de {n} artículos se agotan en {days} días. Lo más pronto: {list}.",
  "runway.overdue": "{name} ya debería haberse agotado",
  "runway.today": "{name} se agota hoy",
  "runway.in": "{name} en {d} días",
  "recall.none": "Revisé {n} productos con {k} avisos de retiro de {regions} y no encontré coincidencias.",
  "recall.heads": "Atención: tu {name} parece estar cubierto por un retiro del mercado por {hazard}. ",
  "recall.found": "Encontré {m} posibles {matches} de retiro entre {n} productos.",
  match: "coincidencia", matches: "coincidencias",
  "plan.empty": "No hace falta reponer nada en ese plazo.",
  "plan.some": "Este es el plan: {n} artículos por {total}{budget}. {dropped}¿Quieres que lo haga?",
  "plan.budget": ", dentro de tu presupuesto de {budget}",
  "plan.dropped": "Dejé fuera {k} para no pasarme del presupuesto. ",
  "confirm.done": "{prefix}Pedido {ref} por {total}. Di «deshacer» en los próximos 10 minutos para cancelarlo.",
  "confirm.prefixNew": "Listo. ", "confirm.prefixReplay": "Eso ya estaba pedido. ",
  "confirm.needcode": "Necesito el código de aprobación de 4 dígitos de la tarjeta del plan antes de pedir. Pide a la persona que lo lea en voz alta. No lo adivines.",
  "confirm.declined": "De acuerdo, no lo pediré.",
  "pref.budget": "Entendido. Mantendré las reposiciones por debajo de {amount}.",
  "pref.skip": "De acuerdo, lo dejaré fuera de los próximos planes.",
  "pref.lang": "De acuerdo, hablaré en {lang} a partir de ahora.",
  "pref.regions": "De acuerdo, revisaré retiros de {regions}.",
  "alerts.new": "Atención: se acaba de publicar un retiro del mercado para tu {name}, por {hazard}. Puse los detalles en pantalla.",
  "alerts.reminder": "Recordatorio: el retiro del mercado de tu {name}, por {hazard}, sigue abierto. Dime cuando dejes de usarlo o pidas la reparación gratuita.",
  "alerts.more": " Tengo {k} más.",
  "alerts.none": "No hay retiros nuevos para nada de lo que tienes.",
};

const hi: Record<Key, string> = {
  import: "{imported} ऑर्डर इंपोर्ट किए। {dups} डुप्लिकेट और {skipped} रद्द या अपठनीय पंक्तियाँ छोड़ दीं, और {repaired} ठीक कीं।",
  "runway.none": "अभी पर्याप्त ऑर्डर इतिहास नहीं है। अपना ऑर्डर इतिहास इंपोर्ट करें, फिर अनुमान शुरू हो जाएगा।",
  "runway.clear": "अगले {days} दिनों में कोई चीज़ खत्म नहीं होगी। कुल {n} चीज़ें ट्रैक हो रही हैं।",
  "runway.some": "{n} में से {due} चीज़ें {days} दिनों में खत्म हो जाएँगी। सबसे पहले: {list}।",
  "runway.overdue": "{name} अब तक खत्म हो चुकी होगी",
  "runway.today": "{name} आज खत्म होगी",
  "runway.in": "{name} {d} दिन में",
  "recall.none": "{k} रिकॉल नोटिस ({regions}) में {n} उत्पाद जाँचे गए और कोई मेल नहीं मिला।",
  "recall.heads": "ध्यान दें: आपका {name} {hazard} के कारण रिकॉल में शामिल लगता है। ",
  "recall.found": "{n} उत्पादों में {m} संभावित रिकॉल {matches} मिले।",
  match: "मेल", matches: "मेल",
  "plan.empty": "उस अवधि में कुछ दोबारा मँगाने की ज़रूरत नहीं है।",
  "plan.some": "योजना यह है: {n} चीज़ें, कुल {total}{budget}। {dropped}क्या इसे ऑर्डर कर दूँ?",
  "plan.budget": ", आपके {budget} के बजट के भीतर",
  "plan.dropped": "बजट में रहने के लिए {k} चीज़ें छोड़ दी गई हैं। ",
  "confirm.done": '{prefix}ऑर्डर {ref}, कुल {total}। रद्द करने के लिए 10 मिनट के भीतर "रद्द करें" कहें।',
  "confirm.prefixNew": "हो गया। ", "confirm.prefixReplay": "यह पहले ही ऑर्डर हो चुका था। ",
  "confirm.needcode": "ऑर्डर करने से पहले प्लान कार्ड पर दिखा 4 अंकों का अनुमोदन कोड चाहिए। व्यक्ति से उसे बोलकर बताने को कहें। अंदाज़ा न लगाएँ।",
  "confirm.declined": "ठीक है, यह ऑर्डर नहीं किया जाएगा।",
  "pref.budget": "ठीक है। रीस्टॉक {amount} से कम रखे जाएँगे।",
  "pref.skip": "ठीक है, इसे आगे की योजनाओं से बाहर रखा जाएगा।",
  "pref.lang": "ठीक है, अब से {lang} में बात होगी।",
  "pref.regions": "ठीक है, {regions} के रिकॉल जाँचे जाएँगे।",
  "alerts.new": "ध्यान दें: आपके {name} के लिए अभी एक नया रिकॉल जारी हुआ है, {hazard}। विवरण स्क्रीन पर है।",
  "alerts.reminder": "याद दिलाना: आपके {name} का रिकॉल, {hazard}, अभी भी खुला है। जब आप इसका उपयोग बंद कर दें या मुफ़्त सुधार माँग लें तो बताइए।",
  "alerts.more": " {k} और हैं।",
  "alerts.none": "आपकी किसी चीज़ के लिए कोई नया रिकॉल नहीं है।",
};

const CATALOG: Record<Lang, Record<Key, string>> = { en, es, hi };

export const isLang = (s: string): s is Lang => s in CATALOG;

export function t(lang: Lang, key: Key, vars: Record<string, string | number> = {}): string {
  return CATALOG[lang][key].replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ""));
}
