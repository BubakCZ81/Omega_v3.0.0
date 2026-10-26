export function createSingleFlightGate(): { acquire: () => (() => void) | null } {
  let inFlight = false;
  return {
    acquire() {
      if (inFlight) return null;
      inFlight = true;
      let acquired = true;
      return () => {
        if (!acquired) return;
        acquired = false;
        inFlight = false;
      };
    },
  };
}
