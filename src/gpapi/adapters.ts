import type { TransactionRecord } from '../types/domain.js';

export interface GpTransactionApiShape {
  id?: string;
  time_created?: string;
  timeCreated?: string;
  reference?: string;
  type?: string;
  channel?: string;
  status?: string;
  amount?: number | string;
  currency?: string;
  response_code?: string;
  response_message?: string;
  account_name?: string;
  accountName?: string;
  payment_method?: {
    entry_mode?: string;
    entryMode?: string;
    card?: {
      brand_reference?: string;
      brand?: string;
      masked_number_last4?: string;
      last4?: string;
      authcode?: string;
      authCode?: string;
    };
  };
}

function coerceAmount(value: number | string | undefined): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number') return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function adaptGpTransaction(apiTxn: GpTransactionApiShape): TransactionRecord {
  // brand_reference is the card-scheme authorization reference (e.g. "555191529963333"),
  // NOT the card brand name. Use brand for the human-readable brand label.
  const cardBrand = apiTxn.payment_method?.card?.brand;
  const last4 = apiTxn.payment_method?.card?.masked_number_last4 ?? apiTxn.payment_method?.card?.last4;
  const authCode = apiTxn.payment_method?.card?.authcode ?? apiTxn.payment_method?.card?.authCode;

  return {
    id: apiTxn.id ?? 'unknown-id',
    timeCreated: apiTxn.time_created ?? apiTxn.timeCreated ?? new Date(0).toISOString(),
    reference: apiTxn.reference,
    type: apiTxn.type,
    channel: apiTxn.channel,
    status: apiTxn.status,
    amount: coerceAmount(apiTxn.amount as number | string | undefined),
    currency: apiTxn.currency,
    responseCode: apiTxn.response_code,
    responseMessage: apiTxn.response_message,
    accountName: apiTxn.account_name ?? apiTxn.accountName,
    paymentMethod: {
      entryMode: apiTxn.payment_method?.entry_mode ?? apiTxn.payment_method?.entryMode,
      cardBrand,
      last4,
      authCode
    },
    cardBrand,
    last4,
    authCode,
    raw: apiTxn
  };
}
