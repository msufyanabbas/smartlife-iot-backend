export enum PaymentStatus {
  PENDING = 'pending',
  SUCCEEDED = 'succeeded',
  FAILED = 'failed',
  REFUNDED = 'refunded',
  CANCELLED = 'cancelled',
}

export enum PaymentMethod {
  CARD = 'card',
  MADA = 'mada',
  APPLE_PAY = 'apple_pay',
  STC_PAY = 'stc_pay',
  OTHER = 'other',
}

export enum PaymentProvider {
  MOYASAR = 'moyasar',
  STRIPE = 'stripe',
}