type TradingSession = {
  name: string;
  timeZone: string;
  openHour: number;
  closeHour: number;
};

const tradingSessions: TradingSession[] = [
  { name: 'Wellington', timeZone: 'Pacific/Auckland', openHour: 8, closeHour: 17 },
  { name: 'Sydney', timeZone: 'Australia/Sydney', openHour: 7, closeHour: 16 },
  { name: 'Tokyo', timeZone: 'Asia/Tokyo', openHour: 9, closeHour: 18 },
  { name: 'Singapore', timeZone: 'Asia/Singapore', openHour: 9, closeHour: 17 },
  { name: 'London', timeZone: 'Europe/London', openHour: 8, closeHour: 17 },
  { name: 'New York', timeZone: 'America/New_York', openHour: 8, closeHour: 17 },
];

const formatters = new Map(tradingSessions.map(session => [
  session.name,
  new Intl.DateTimeFormat('en-US', {
    timeZone: session.timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }),
]));

export function getOpenTradingSessions(now: Date): string[] {
  return tradingSessions
    .filter(session => {
      const parts = formatters.get(session.name)!.formatToParts(now);
      const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
      const weekday = values.weekday;
      const hour = Number(values.hour);
      const minute = Number(values.minute);
      const minutesSinceMidnight = hour * 60 + minute;

      return weekday !== 'Sat'
        && weekday !== 'Sun'
        && minutesSinceMidnight >= session.openHour * 60
        && minutesSinceMidnight < session.closeHour * 60;
    })
    .map(session => session.name);
}

export function formatTradingSessionStatus(sessions: string[]): string {
  if (sessions.includes('London') && sessions.includes('New York')) {
    return `Trading sessions: ${sessions.filter(name => name !== 'London' && name !== 'New York').join(', ')}${sessions.length > 2 ? ', ' : ''}London–New York overlap`;
  }

  return sessions.length > 0
    ? `Trading sessions: ${sessions.join(', ')}`
    : 'No major trading sessions open';
}
