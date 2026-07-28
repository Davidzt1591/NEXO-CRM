import { useState } from 'react';

export function useConnectionDialog({ onResetPairing }) {
  const [mode, setMode] = useState('qr'); const [phone, setPhone] = useState('');
  const selectMode = next => { setMode(next); onResetPairing(); };
  const changePhone = value => { setPhone(value); onResetPairing(); };
  return { mode, phone, selectMode, changePhone, validPhone: phone.replace(/\D/g, '').length >= 7 };
}
