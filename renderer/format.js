// Textos em português: formatação da tela e frases do resumo falado.

const PHRASE = (code) => {
  if (code === 0 || code === 1) return 'o céu está limpo';
  if (code === 2) return 'o céu está parcialmente nublado';
  if (code === 3) return 'o céu está nublado';
  if (code === 45 || code === 48) return 'há neblina';
  if (code >= 51 && code <= 57) return 'há garoa';
  if (code >= 61 && code <= 67) return 'está chovendo';
  if (code >= 71 && code <= 77) return 'está nevando';
  if (code >= 80 && code <= 82) return 'há pancadas de chuva';
  if (code === 85 || code === 86) return 'há pancadas de neve';
  if (code >= 95) return 'há trovoadas';
  return 'o tempo está instável';
};

const LABEL = {
  0: 'Céu limpo', 1: 'Céu quase limpo', 2: 'Parcialmente nublado', 3: 'Nublado',
  45: 'Neblina', 48: 'Neblina com geada', 51: 'Garoa fraca', 53: 'Garoa', 55: 'Garoa forte',
  56: 'Garoa congelante', 57: 'Garoa congelante forte', 61: 'Chuva fraca', 63: 'Chuva', 65: 'Chuva forte',
  66: 'Chuva congelante', 67: 'Chuva congelante forte', 71: 'Neve fraca', 73: 'Neve', 75: 'Neve forte',
  77: 'Grãos de neve', 80: 'Pancadas de chuva fracas', 81: 'Pancadas de chuva', 82: 'Pancadas de chuva fortes',
  85: 'Pancadas de neve', 86: 'Pancadas de neve fortes', 95: 'Trovoada', 96: 'Trovoada com granizo', 99: 'Trovoada com granizo forte',
};
export const weatherLabel = (code) => LABEL[code] ?? 'Tempo instável';

export function greeting(d = new Date()) {
  const h = d.getHours();
  return h >= 5 && h < 12 ? 'Bom dia' : h >= 12 && h < 18 ? 'Boa tarde' : 'Boa noite';
}

export const formatClock = (d) =>
  d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', hour12: false });

export const formatDate = (d) =>
  d.toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' });

export function relativeTime(ms, now = Date.now()) {
  if (!ms) return '';
  const min = Math.max(0, Math.round((now - ms) / 60000));
  if (min < 1) return 'agora';
  if (min < 60) return `há ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `há ${h} h`;
  const days = Math.round(h / 24);
  return days === 1 ? 'ontem' : `há ${days} dias`;
}

const graus = (n) => {
  const v = Math.round(n);
  const abs = Math.abs(v);
  return `${v < 0 ? 'menos ' : ''}${abs} ${abs === 1 ? 'grau' : 'graus'}`;
};

function timeSentence(d) {
  const h = d.getHours();
  const m = d.getMinutes();
  if (m === 0 && h === 0) return 'É meia-noite.';
  if (m === 0 && h === 12) return 'É meio-dia.';
  const hh = h % 12 === 0 && h !== 0 ? 12 : h;
  const hora = `${hh} ${hh === 1 ? 'hora' : 'horas'}`;
  const verbo = hh === 1 ? 'É' : 'São';
  if (m === 0) return `${verbo} ${hora} em ponto.`;
  return `${verbo} ${hora} e ${m} ${m === 1 ? 'minuto' : 'minutos'}.`;
}

/** "às 10", "às 14 e 30", "à 1 hora": como a hora se fala. */
export function spokenHour(d) {
  const h = d.getHours();
  const m = d.getMinutes();
  if (h === 12 && m === 0) return 'ao meio-dia';
  if (h === 0 && m === 0) return 'à meia-noite';
  const a = h === 1 ? 'à' : 'às';
  const hh = h === 1 ? 'uma hora' : `${h} ${h === 1 ? 'hora' : 'horas'}`;
  return m === 0 ? `${a} ${hh}` : `${a} ${h === 1 ? 'uma' : h} e ${m}`;
}

export function eventSentence(e) {
  const title = e.title.replace(/[.!?…\s]+$/, '').slice(0, 100);
  if (e.allDay) return `${title}, o dia todo.`;
  return `${title}, ${spokenHour(new Date(e.start))}.`;
}

const trimTitle = (t) => t.replace(/[.!?…\s]+$/, '').slice(0, 150);

/** Monta as frases do resumo do dia. Cada frase vira um áudio (e uma legenda na tela). */
export function buildBriefing({ name, nameSpoken, now, weather, cityName, news, agenda }) {
  const g = greeting(now);
  const out = [
    { show: `${g}, ${name}.`, say: `${g}, ${nameSpoken || name}.` },
    timeSentence(now),
    `Hoje é ${formatDate(now)}.`,
  ];

  if (weather?.current) {
    const c = weather.current;
    const d = weather.daily;
    out.push(`Em ${cityName}, agora faz ${graus(c.temperature_2m)} e ${PHRASE(c.weather_code)}.`);
    if (d?.temperature_2m_max?.[0] != null) {
      out.push(`A máxima de hoje é de ${graus(d.temperature_2m_max[0])}, e a mínima, de ${graus(d.temperature_2m_min[0])}.`);
    }
    const rain = d?.precipitation_probability_max?.[0];
    if (rain >= 20) out.push(`A chance de chuva é de ${Math.round(rain)} por cento.`);
  } else {
    out.push('Não consegui consultar o clima agora.');
  }

  if (agenda?.needsReconnect) {
    out.push('O acesso ao Google expirou. Conecte de novo nos Ajustes para eu voltar a ler a sua agenda.');
  }
  if (agenda?.connected && !agenda.error) {
    const events = agenda.events ?? [];
    // só o que ainda vai acontecer (ou o dia inteiro); o que já passou hoje não interessa
    const upcoming = events.filter((e) => e.allDay || new Date(e.end || e.start) > now);
    if (!events.length) out.push('Sua agenda está livre hoje.');
    else if (!upcoming.length) out.push('Você não tem mais compromissos hoje.');
    else {
      out.push(upcoming.length === 1 ? 'Você tem um compromisso hoje.' : `Você tem ${upcoming.length} compromissos hoje.`);
      for (const e of upcoming.slice(0, 4)) out.push(eventSentence(e));
    }
    const tasks = agenda.tasks ?? [];
    if (tasks.length === 1) out.push(`Você tem uma tarefa pendente: ${trimTitle(tasks[0].title)}.`);
    else if (tasks.length > 1) out.push(`Você tem ${tasks.length} tarefas pendentes, entre elas ${trimTitle(tasks[0].title)}.`);
  }

  const top = (news || []).slice(0, 3);
  if (top.length) {
    out.push('Estas são as principais manchetes.');
    for (const n of top) out.push(`${trimTitle(n.title)}.`);
  }
  out.push('Isso é tudo por enquanto.');
  return out;
}
