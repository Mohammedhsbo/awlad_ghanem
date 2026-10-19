function normalizeApiBase(url: string) {
  const normalized = url.replace(/\/+$/, '');
  return normalized.endsWith('/api/v1') ? normalized : `${normalized}/api/v1`;
}

import type {
  CreatePOSTransactionDto,
  CreatePOSTransactionResponse,
  POSCustomerSearchQuery,
  POSCustomerSearchResponse,
  POSMotorcycleSearchQuery,
  POSActiveReservationsQuery,
  ValidatePOSTransactionDto,
  ValidatePOSTransactionResponse,
  QueueOfflineOperationDto,
} from '../../../packages/shared-types/src/pos';

const configuredApiUrl = import.meta.env.VITE_API_URL;
if (!configuredApiUrl) {
  throw new Error('VITE_API_URL must be configured before starting the desktop app.');
}
const API_BASE = normalizeApiBase(configuredApiUrl);

export function getApiErrorMessage(reason: unknown, fallback = 'Request failed') {
  if (reason instanceof Error && reason.message) {
    if (reason.name === 'TypeError' && /fetch|network|failed/i.test(reason.message)) return 'Network unavailable. Check the connection and try again.';
    return reason.message;
  }
  return fallback;
}

let authToken: string | null = localStorage.getItem('pos_token');

export interface DesktopUser {
  id: string;
  name: string;
  email: string;
  role: {
    id: string;
    name: string;
    permissions: Array<{ resource: string; action: string }>;
  };
  branchId?: string | null;
  branch?: { id: string; nameAr: string; nameEn: string } | null;
  whatsappSenderNumber?: string | null;
  lang: 'ar' | 'en';
}

export interface BranchSummary {
  id: string;
  nameAr: string;
  nameEn: string;
  isActive?: boolean;
  address?: string | null;
  phone?: string | null;
}

export interface RoleSummary {
  id: string;
  name: string;
  description?: string | null;
  isSystem: boolean;
}

export interface UserListItem {
  id: string;
  name: string;
  email: string;
  phone?: string | null;
  whatsappSenderNumber?: string | null;
  role: { id: string; name: string };
  branch?: BranchSummary | null;
  isActive: boolean;
  lang?: 'ar' | 'en';
  lastLoginAt?: string | null;
  createdAt?: string;
}

export interface CreateUserInput {
  name: string;
  email: string;
  password: string;
  roleId: string;
  branchId?: string;
  whatsappSenderNumber?: string;
}

export interface SelfUpdateUserInput {
  name?: string;
  phone?: string;
  whatsappSenderNumber?: string;
  currentPassword?: string;
  newPassword?: string;
}

export interface UpdateUserInput {
  name?: string;
  email?: string;
  phone?: string;
  whatsappSenderNumber?: string;
  roleId?: string;
  branchId?: string | null;
  lang?: 'ar' | 'en';
  isActive?: boolean;
}

export function setToken(token: string) {
  authToken = token;
  localStorage.setItem('pos_token', token);
}

export function getToken() { return authToken; }
export function clearToken() { authToken = null; localStorage.removeItem('pos_token'); }
export function setUser(user: DesktopUser) { localStorage.setItem('pos_user', JSON.stringify(user)); }
export function getUser(): DesktopUser | null {
  const stored = localStorage.getItem('pos_user');
  if (!stored) return null;
  try { return JSON.parse(stored) as DesktopUser; } catch { return null; }
}
export function clearUser() { localStorage.removeItem('pos_user'); }

async function refreshAccessToken() {
  const response = await fetch(`${API_BASE}/auth/refresh`, {
    method: 'POST',
    credentials: 'include',
  });
  if (!response.ok) throw new Error('Session refresh failed');
  const json = await response.json();
  const token = json.data?.accessToken;
  if (!token) throw new Error('Session refresh returned no access token');
  setToken(token);
}

async function apiFetch<T>(path: string, options: RequestInit = {}, canRefresh = true): Promise<T> {
  const isFormData = options.body instanceof FormData;
  const headers: Record<string, string> = {
    ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
    ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
    ...(options.headers as Record<string, string> ?? {}),
  };
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { ...options, headers, credentials: 'include' });
  } catch (reason) {
    throw new Error(getApiErrorMessage(reason, 'Network unavailable. Check the connection and try again.'));
  }
  let json: Record<string, any> = {};
  try { json = await res.json() as Record<string, any>; } catch { /* Empty responses are valid for some requests. */ }
  if (res.status === 401 && canRefresh && path !== '/auth/login' && path !== '/auth/refresh') {
    try {
      await refreshAccessToken();
      return apiFetch<T>(path, options, false);
    } catch {
      clearToken();
      window.dispatchEvent(new Event('pos-auth-expired'));
    }
  }
  if (!res.ok) {
    const errorBody = json.error && typeof json.error === 'object' ? json.error : json;
    const err = new Error(errorBody.message ?? 'Request failed') as Error & { code?: string; status?: number; details?: unknown };
    err.code = errorBody.code;
    err.status = res.status;
    err.details = errorBody.details;
    throw err;
  }
  if (Array.isArray(json.data) && json.meta) {
    return { items: json.data, ...json.meta } as T;
  }
  if (Array.isArray(json.items) && json.meta) {
    return { items: json.items, ...json.meta } as T;
  }
  return (Object.prototype.hasOwnProperty.call(json, 'data') ? json.data : json) as T;
}

// ─── Auth ────────────────────────────────────────────────
export const auth = {
  login: (email: string, password: string) =>
    apiFetch<{ accessToken: string; user: DesktopUser }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),
  me: () => apiFetch<DesktopUser>('/auth/me'),
  logout: () => apiFetch<null>('/auth/logout', { method: 'POST' }),
};

export const branches = {
  list: (all?: boolean) => apiFetch<{ items: BranchSummary[]; total: number }>(`/branches?limit=100${all ? '' : '&isActive=true'}`),
  create: (data: Partial<BranchSummary>) => apiFetch<BranchSummary>('/branches', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: string, data: Partial<BranchSummary>) => apiFetch<BranchSummary>(`/branches/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  delete: (id: string) => apiFetch<void>(`/branches/${id}`, { method: 'DELETE' }),
};

export const roles = {
  list: () => apiFetch<RoleSummary[]>('/roles'),
};

export const users = {
  list: () => apiFetch<{ items: UserListItem[]; total: number }>('/users?limit=100'),
  create: (data: CreateUserInput) => apiFetch<UserListItem>('/users', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: string, data: UpdateUserInput) => apiFetch<UserListItem>(`/users/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  remove: (id: string) => apiFetch<void>(`/users/${id}`, { method: 'DELETE' }),
  me: () => apiFetch<UserListItem>('/users/me'),
  updateMe: (data: SelfUpdateUserInput) => apiFetch<UserListItem>('/users/me', { method: 'PATCH', body: JSON.stringify(data) }),
};

// ─── Types ───────────────────────────────────────────────
export type PurchaseStatus = 'draft' | 'ordered' | 'partially_received' | 'received' | 'cancelled';

export interface PurchaseItem {
  id: string;
  model: string;
  vin?: string;
  quantity: number;
  unitCost: number | string;
  motorcycleId?: string;
}

export interface Purchase {
  id: string;
  purchaseNumber: string;
  supplierId: string;
  supplier?: { id: string; name: string; phone?: string };
  branchId: string;
  branch?: { nameEn: string; nameAr: string };
  status: PurchaseStatus;
  totalAmount: string;
  orderedAt?: string;
  receivedAt?: string;
  createdAt: string;
  items: PurchaseItem[];
}

export interface ReceiveItemInput { purchaseItemId: string; vin: string; }

export interface PurchaseCreateInput {
  supplierId: string;
  branchId: string;
  notes?: string;
  items: Array<{ model: string; vin?: string; quantity: number; unitCost: number }>;
}

// ─── Purchases API ───────────────────────────────────────
export const purchases = {
  list: (params?: { page?: number; limit?: number; status?: string; branchId?: string; supplierId?: string; search?: string }) => {
    const q = new URLSearchParams();
    if (params?.page) q.set('page', String(params.page));
    if (params?.limit) q.set('limit', String(params.limit));
    if (params?.status) q.set('status', params.status);
    if (params?.branchId) q.set('branchId', params.branchId);
    if (params?.supplierId) q.set('supplierId', params.supplierId);
    if (params?.search) q.set('search', params.search);
    return apiFetch<{ items: Purchase[]; meta: { total: number; page: number; limit: number; totalPages: number } }>(`/purchases?${q}`);
  },
  listPending: () =>
    apiFetch<{ items: Purchase[]; total: number }>('/purchases?status=ordered&limit=50')
      .then(async (res) => {
        const partial = await apiFetch<{ items: Purchase[]; total: number }>('/purchases?status=partially_received&limit=50');
        return { items: [...res.items, ...partial.items], total: res.total + partial.total };
      }),
  get: (id: string) => apiFetch<Purchase>(`/purchases/${id}`),
  create: (data: PurchaseCreateInput) =>
    apiFetch<Purchase>('/purchases', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: string, data: Partial<PurchaseCreateInput>) =>
    apiFetch<Purchase>(`/purchases/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  order: (id: string) => apiFetch<Purchase>(`/purchases/${id}/order`, { method: 'POST' }),
  cancel: (id: string) => apiFetch<Purchase>(`/purchases/${id}/cancel`, { method: 'POST' }),
  remove: (id: string) => apiFetch<void>(`/purchases/${id}`, { method: 'DELETE' }),
  receive: (id: string, items: ReceiveItemInput[]) =>
    apiFetch<Purchase>(`/purchases/${id}/receive`, {
      method: 'POST',
      body: JSON.stringify({ items }),
    }),
};

// ─── Customers API (POS) ─────────────────────────────────
export interface CustomerSearchResult {
  id: string;
  name: string;
  phone: string;
  email?: string;
  nationalId?: string;
  defaultAddress?: {
    id?: string;
    addressLine: string;
    city?: string;
  } | null;
  recentOrderCount?: number;
  activeReservationCount?: number;
  lastTransactionDate?: string;
  isActive?: boolean;
}

export interface CustomerDetail {
  id: string;
  name: string;
  phone: string;
  email?: string;
  nationalId?: string;
  notes?: string;
  isActive: boolean;
  addresses: Array<{
    id: string;
    label: string;
    addressLine: string;
    city?: string;
    region?: string;
    postalCode?: string;
    country: string;
    isDefault: boolean;
  }>;
  createdAt: string;
}

export interface CustomerInput {
  name: string;
  phone: string;
  email?: string;
  nationalId?: string;
  notes?: string;
}

export const customers = {
  list: (params?: { page?: number; limit?: number; search?: string; isActive?: boolean }) => {
    const q = new URLSearchParams();
    q.set('page', String(params?.page ?? 1));
    q.set('limit', String(params?.limit ?? 10));
    if (params?.search) q.set('search', params.search);
    if (params?.isActive !== undefined) q.set('isActive', String(params.isActive));
    return apiFetch<{ items: CustomerSearchResult[]; total: number; page: number; limit: number; totalPages: number }>(`/customers?${q}`);
  },
  search: (params: { q: string; limit?: number }) => {
    const q = new URLSearchParams();
    q.set('q', params.q);
    if (params.limit) q.set('limit', String(params.limit));
    return apiFetch<CustomerSearchResult[]>(`/customers/search?${q}`);
  },
  get: (id: string) => apiFetch<CustomerDetail>(`/customers/${id}`),
  create: (data: CustomerInput) =>
    apiFetch<CustomerDetail>('/customers', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: string, data: Partial<CustomerInput>) =>
    apiFetch<CustomerDetail>(`/customers/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deactivate: (id: string) => apiFetch<CustomerDetail>(`/customers/${id}/deactivate`, { method: 'POST' }),
  reactivate: (id: string) => apiFetch<CustomerDetail>(`/customers/${id}/reactivate`, { method: 'POST' }),
};

export interface CustomerInquiry {
  id: string;
  customerId: string;
  customer: { id: string; name: string; phone: string };
  address: string;
  phone: string;
  occupation: string;
  occupationAddress: string;
  idCardFrontImage: string;
  idCardBackImage: string;
  createdBy: string;
  createdAt: string;
}

export interface CustomerInquiryInput {
  customerId: string;
  address: string;
  phone: string;
  occupation: string;
  occupationAddress: string;
  idCardFrontImage: File;
  idCardBackImage: File;
}

export const customerInquiries = {
  list: () => apiFetch<CustomerInquiry[]>('/customer-inquiries'),
  get: (id: string) => apiFetch<CustomerInquiry>(`/customer-inquiries/${id}`),
  create: (input: CustomerInquiryInput) => {
    const form = new FormData();
    form.set('customerId', input.customerId);
    form.set('address', input.address);
    form.set('phone', input.phone);
    form.set('occupation', input.occupation);
    form.set('occupationAddress', input.occupationAddress);
    form.set('idCardFrontImage', input.idCardFrontImage);
    form.set('idCardBackImage', input.idCardBackImage);
    return apiFetch<CustomerInquiry>('/customer-inquiries', { method: 'POST', body: form });
  },
  sendWhatsApp: (id: string) => apiFetch<{ phone: string; message: string }>(`/customer-inquiries/${id}/send-whatsapp`, { method: 'POST' }),
};

// ─── Motorcycles API (POS) ───────────────────────────────
export interface MotorcycleSearchResult {
  id: string;
  vin: string;
  engineNumber?: string | null;
  model: string;
  year: number;
  color?: string;
  price: number;
  costPrice?: number;
  status: string;
  brand: { id: string; nameEn: string; nameAr: string };
  branch: { id: string; nameEn: string; nameAr: string };
  category?: { id?: string; nameEn: string; nameAr: string };
  images?: string[];
}

export interface BrandSummary {
  id: string;
  nameEn: string;
  nameAr: string;
  isActive?: boolean;
}

export interface CategorySummary {
  id: string;
  nameEn: string;
  nameAr: string;
  parentId?: string | null;
  isActive?: boolean;
  depth?: number;
  path?: string;
}

export const brands = {
  list: (params?: { isActive?: boolean }) => {
    const query = new URLSearchParams();
    if (params?.isActive !== undefined) query.set('isActive', String(params.isActive));
    return apiFetch<BrandSummary[]>(`/brands?${query}`);
  },
};

export const categories = {
  list: (params?: { isActive?: boolean; flat?: boolean }) => {
    const query = new URLSearchParams();
    if (params?.isActive !== undefined) query.set('isActive', String(params.isActive));
    if (params?.flat !== undefined) query.set('flat', String(params.flat));
    return apiFetch<CategorySummary[]>(`/categories?${query}`);
  },
};

export interface MotorcycleInput {
  vin?: string;
  engineNumber?: string;
  model: string;
  year: number;
  color?: string;
  price?: number;
  costPrice?: number;
  brandId?: string;
  categoryId?: string;
  branchId?: string;
  images?: string[];
}

type MotorcycleCreatePayload = Required<Pick<MotorcycleInput, 'vin' | 'model' | 'year' | 'price' | 'costPrice' | 'brandId' | 'categoryId' | 'branchId'>> & Pick<MotorcycleInput, 'engineNumber' | 'images'>;

export const motorcycles = {
  search: (params: { search?: string; branchId?: string; status?: string; limit?: number }) => {
    const q = new URLSearchParams();
    if (params.search) q.set('search', params.search);
    if (params.branchId) q.set('branchId', params.branchId);
    if (params.status) q.set('status', params.status);
    if (params.limit) q.set('limit', String(params.limit));
    return apiFetch<{ items: MotorcycleSearchResult[]; total: number }>(`/motorcycles?${q}`);
  },
  get: (id: string) => apiFetch<MotorcycleSearchResult>(`/motorcycles/${id}`),
  create: (data: MotorcycleCreatePayload) => apiFetch<MotorcycleSearchResult>('/motorcycles', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: string, data: MotorcycleInput) => apiFetch<MotorcycleSearchResult>(`/motorcycles/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  updateStatus: (id: string, status: string, reason?: string) => apiFetch<MotorcycleSearchResult>(`/motorcycles/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status, reason }) }),
  remove: (id: string) => apiFetch<void>(`/motorcycles/${id}`, { method: 'DELETE' }),
};

export const upload = {
  uploadFile: (file: File) => {
    const formData = new FormData();
    formData.append('file', file);
    return apiFetch<{ url: string; filename: string; size: number; mimeType: string }>('/upload', {
      method: 'POST',
      body: formData,
    });
  },
};

// ─── Transfers API ──────────────────────────────────────
export type TransferStatus = 'initiated' | 'in_transit' | 'received' | 'cancelled';
export interface TransferListItem { id: string; transferNumber: string; fromBranch: BranchSummary; toBranch: BranchSummary; motorcycleCount: number; status: TransferStatus; createdAt: string; completedAt?: string | null; }
export interface TransferDetail extends TransferListItem { notes?: string | null; motorcycles: Array<{ id: string; vin: string; model: string; brand: { nameEn: string; nameAr: string }; currentStatus: string; currentBranchId: string; }>; }
export interface CreateTransferInput { fromBranchId?: string; toBranchId: string; motorcycleIds: string[]; notes?: string; }
export const transfers = {
  list: (params?: { status?: TransferStatus; search?: string; fromBranchId?: string; toBranchId?: string; limit?: number }) => { const query = new URLSearchParams({ page: '1', limit: String(params?.limit ?? 50) }); if (params?.status) query.set('status', params.status); if (params?.search) query.set('search', params.search); if (params?.fromBranchId) query.set('fromBranchId', params.fromBranchId); if (params?.toBranchId) query.set('toBranchId', params.toBranchId); return apiFetch<{ items: TransferListItem[]; total: number; page: number; limit: number; totalPages: number }>(`/transfers?${query}`); },
  get: (id: string) => apiFetch<TransferDetail>(`/transfers/${id}`),
  create: (data: CreateTransferInput) => apiFetch<TransferDetail>('/transfers', { method: 'POST', body: JSON.stringify(data) }),
  ship: (id: string) => apiFetch<TransferListItem>(`/transfers/${id}/ship`, { method: 'POST' }),
  receive: (id: string) => apiFetch<TransferListItem>(`/transfers/${id}/receive`, { method: 'POST' }),
  cancel: (id: string) => apiFetch<TransferListItem>(`/transfers/${id}/cancel`, { method: 'POST' }),
};

// ─── Orders API (POS) ────────────────────────────────────
export type OrderStatus = 'draft' | 'confirmed' | 'processing' | 'awaiting_delivery' | 'completed' | 'cancelled' | 'refunded';
export type DesktopOrderPaymentType = 'CASH' | 'INSTALLMENT';

export interface OrderItem {
  id: string;
  motorcycleId: string;
  unitPrice: number;
  discount: number;
  motorcycle: {
    id: string;
    vin: string;
    model: string;
    year: number;
    color?: string;
    brand: { nameEn: string; nameAr: string };
    currentStatus: string;
  };
}

export interface Order {
  id: string;
  orderNumber: string;
  customerId: string;
  branchId: string;
  status: OrderStatus;
  paymentType: DesktopOrderPaymentType;
  totalAmount: number;
  discount: number;
  netAmount: number;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface OrderListItem {
  id: string;
  orderNumber: string;
  customer: { id: string; name: string; phone: string };
  branch: { id: string; nameEn: string; nameAr: string };
  status: OrderStatus;
  paymentType: DesktopOrderPaymentType;
  itemCount: number;
  totalAmount: number;
  discount: number;
  netAmount: number;
  createdAt: string;
}

export interface OrderDetail extends Order {
  customerIdImage?: string | null;
  customer: {
    id: string;
    name: string;
    phone: string;
    email?: string;
    defaultAddress?: { addressLine: string; city?: string };
  };
  branch: { id: string; nameEn: string; nameAr: string };
  user: { id: string; name: string };
  items: OrderItem[];
}

export interface CreateOrderInput {
  customerId: string;
  motorcycleIds: string[];
  discount?: number;
  address?: string;
  notes?: string;
  isDraft?: boolean;
}

export const orders = {
  list: (params?: { search?: string; customerId?: string; status?: OrderStatus; startDate?: string; endDate?: string; page?: number; limit?: number }) => {
    const q = new URLSearchParams();
    if (params?.search) q.set('search', params.search);
    if (params?.customerId) q.set('customerId', params.customerId);
    if (params?.status) q.set('status', params.status);
    if (params?.startDate) q.set('startDate', params.startDate);
    if (params?.endDate) q.set('endDate', params.endDate);
    if (params?.page) q.set('page', String(params.page));
    if (params?.limit) q.set('limit', String(params.limit));
    return apiFetch<{ items: OrderListItem[]; total: number; page: number; limit: number; totalPages: number }>(`/orders?${q}`);
  },
  get: (id: string) => apiFetch<OrderDetail>(`/orders/${id}`),
  create: (data: CreateOrderInput) =>
    apiFetch<OrderDetail>('/orders', { method: 'POST', body: JSON.stringify(data) }),
  confirm: (id: string) =>
    apiFetch<OrderDetail>(`/orders/${id}/confirm`, { method: 'POST' }),
  updateStatus: (id: string, status: OrderStatus) =>
    apiFetch<OrderDetail>(`/orders/${id}/status`, { method: 'POST', body: JSON.stringify({ status }) }),
  cancel: (id: string, reason?: string) =>
    apiFetch<OrderDetail>(`/orders/${id}/cancel`, { method: 'POST', body: JSON.stringify({ reason }) }),
  getCustomerOrders: (customerId: string, params?: { page?: number; limit?: number }) => {
    const q = new URLSearchParams();
    if (params?.page) q.set('page', String(params.page));
    if (params?.limit) q.set('limit', String(params.limit));
    return apiFetch<{ items: OrderListItem[]; total: number }>(`/customers/${customerId}/orders?${q}`);
  },
};

// ─── Reservations API (POS) ──────────────────────────────
export type ReservationStatus = 'active' | 'expired' | 'cancelled' | 'converted';
export type ReservationSource = 'ecommerce' | 'pos';

export interface ReservationListItem {
  id: string;
  reservationNumber: string;
  customer: { id: string; name: string; phone: string };
  motorcycle: {
    id: string;
    vin: string;
    model: string;
    year: number;
    color?: string;
    brand: { nameEn: string; nameAr: string };
  };
  branch: { id: string; nameEn: string; nameAr: string };
  status: ReservationStatus;
  source: ReservationSource;
  totalPrice: number;
  depositAmount: number;
  remainingAmount: number;
  expiresAt?: string;
  daysUntilExpiry?: number;
  createdAt: string;
}

export interface ReservationDetail extends Omit<ReservationListItem, 'customer'> {
  customerIdImage?: string | null;
  customer: {
    id: string;
    name: string;
    phone: string;
    email?: string;
    defaultAddress?: {
      addressLine: string;
      city?: string;
    };
  };
  user: { id: string; name: string };
  address?: string | null;
  notes?: string;
  cancelReason?: string;
  convertedOrder?: { id: string; orderNumber: string; status: string };
  pricingSnapshot: {
    basePrice: number;
    vat: number;
    discount: number;
    totalPrice: number;
  };
}

export interface CreateReservationInput {
  customerId: string;
  motorcycleId: string;
  paidAmount: number;
  address?: string;
  notes?: string;
}

export const reservations = {
  list: (params?: { search?: string; customerId?: string; status?: ReservationStatus; page?: number; limit?: number }) => {
    const q = new URLSearchParams();
    if (params?.search) q.set('search', params.search);
    if (params?.customerId) q.set('customerId', params.customerId);
    if (params?.status) q.set('status', params.status);
    if (params?.page) q.set('page', String(params.page));
    if (params?.limit) q.set('limit', String(params.limit));
    return apiFetch<{ items: ReservationListItem[]; total: number; page: number; limit: number }>(`/reservations?${q}`);
  },
  get: (id: string) => apiFetch<ReservationDetail>(`/reservations/${id}`),
  sendWhatsApp: (id: string) => apiFetch<{ phone: string; message: string }>(`/reservations/${id}/send-whatsapp`, { method: 'POST' }),
  create: (data: CreateReservationInput) =>
    apiFetch<ReservationDetail>('/reservations', { method: 'POST', body: JSON.stringify(data) }),
  convert: (id: string, notes?: string, idempotencyKey?: string) =>
    apiFetch<{ reservation: ReservationDetail; order: { id: string; orderNumber: string } }>(`/reservations/${id}/convert`, {
      method: 'POST',
      headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined,
      body: JSON.stringify({ notes }),
    }),
  cancel: (id: string, reason: string) =>
    apiFetch<ReservationDetail>(`/reservations/${id}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),
  update: (id: string, data: { expiresAt?: string; notes?: string }) =>
    apiFetch<ReservationDetail>(`/reservations/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  extend: (id: string, expiresAt: string, reason?: string) =>
    apiFetch<ReservationDetail>(`/reservations/${id}/extend`, { method: 'POST', body: JSON.stringify({ expiresAt, reason }) }),
  getCustomerReservations: (customerId: string, params?: { page?: number; limit?: number }) => {
    const q = new URLSearchParams();
    if (params?.page) q.set('page', String(params.page));
    if (params?.limit) q.set('limit', String(params.limit));
    return apiFetch<{ items: ReservationListItem[]; total: number }>(`/customers/${customerId}/reservations?${q}`);
  },
};

// ─── Payments API (POS) ──────────────────────────────────
export type PaymentMethod = 'cash' | 'card' | 'bank_transfer' | 'cheque';
export type PaymentStatus = 'pending' | 'completed' | 'failed' | 'cancelled' | 'refunded' | 'partially_refunded';

export interface CreatePaymentInput {
  idempotencyKey: string;
  invoiceId: string;
  amount: number;
  method: PaymentMethod;
  reference?: string;
  cashDetails?: {
    amountReceived: number;
    change: number;
  };
  notes?: string;
}

export interface PaymentResult {
  id: string;
  paymentReference: string;
  invoiceId: string;
  amount: number;
  method: PaymentMethod;
  status: PaymentStatus;
  cashAmountReceived?: number;
  cashChange?: number;
  createdAt: string;
}

export const payments = {
  create: (data: CreatePaymentInput) =>
    apiFetch<PaymentResult>('/payments', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  get: (id: string) => apiFetch<PaymentResult>(`/payments/${id}`),
};

// ─── Invoices API (POS) ──────────────────────────────────
export interface Invoice {
  id: string;
  invoiceNumber: string;
  customerId: string;
  orderId?: string;
  status: string;
  totalAmount: number;
  paidAmount: number;
  remainingAmount: number;
  createdAt: string;
}

export interface CreateInvoiceInput {
  customerId: string;
  orderId?: string;
  reservationId?: string;
  branchId?: string;
  totalAmount: number;
  items: Array<{
    motorcycleId: string;
    description: string;
    quantity: number;
    unitPrice: number;
    discount: number;
  }>;
  notes?: string;
}

export const invoices = {
  create: (data: CreateInvoiceInput) => apiFetch<Invoice>('/invoices', { method: 'POST', body: JSON.stringify(data) }),
  issue: (id: string) => apiFetch<Invoice>(`/invoices/${id}/issue`, { method: 'POST' }),
  getByOrder: (orderId: string) => apiFetch<Invoice>(`/invoices?orderId=${orderId}`).then((res: any) => res.items?.[0]),
  get: (id: string) => apiFetch<Invoice>(`/invoices/${id}`),
};

// ─── POS API ─────────────────────────────────────────────

export interface POSDashboard {
  currentUser: {
    id: string;
    name: string;
    role: string;
    branch: {
      id: string;
      nameAr: string;
      nameEn: string;
    } | null;
    permissions: {
      canApplyDiscount: boolean;
      maxDiscountPercent: number;
      maxDiscountAmount: number;
      canCreateCustomer: boolean;
      canSwitchBranch: boolean;
    };
  };
  todayStats: {
    ordersCreated: number;
    reservationsCreated: number;
    totalSales: number;
    availableMotorcycles: number;
  };
  recentTransactions: Array<{
    id: string;
    type: 'order' | 'reservation';
    number: string;
    customerName: string;
    motorcycleModel: string;
    amount: number;
    createdAt: string;
  }>;
}

export interface POSSyncStatus {
  isOnline: boolean;
  lastSyncAt?: string;
  queuedOperations: number;
  syncInProgress: boolean;
  conflicts: Array<{
    operationId: string;
    type: string;
    reason: string;
    resolution: string;
  }>;
}

export interface POSReservation {
  id: string;
  reservationNumber: string;
  customer: {
    id: string;
    name: string;
    phone: string;
  };
  motorcycle: {
    id: string;
    vin: string;
    model: string;
    brand: string;
  };
  depositAmount: number;
  totalAmount: number;
  remainingAmount: number;
  expiresAt: string;
  expiresInDays: number;
  daysUntilExpiry?: number;
  isExpiringSoon: boolean;
  createdAt: string;
}

export const pos = {
  getDashboard: () => apiFetch<POSDashboard>('/pos/dashboard'),
  
  searchCustomers: (q: string, limit = 10, page = 1) =>
    apiFetch<POSCustomerSearchResponse>(`/pos/customers/search?q=${encodeURIComponent(q)}&limit=${limit}&page=${page}`),
  
  searchMotorcycles: (q?: string, branchId?: string, limit = 20) => {
    const params = new URLSearchParams();
    if (q) params.append('q', q);
    if (branchId) params.append('branchId', branchId);
    params.append('limit', limit.toString());
    return apiFetch<MotorcycleSearchResult[]>(`/pos/motorcycles/search?${params}`);
  },
  
  validateTransaction: (data: ValidatePOSTransactionDto) =>
    apiFetch<ValidatePOSTransactionResponse>('/pos/validate-transaction', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  
  createTransaction: (data: CreatePOSTransactionDto) =>
    apiFetch<CreatePOSTransactionResponse>('/pos/transactions', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  createCashSale: (input: SaleInput) => {
    const form = new FormData();
    form.set('motorcycleId', input.motorcycleId);
    form.set('customerName', input.customerName);
    form.set('customerPhone', input.customerPhone);
    form.set('salePrice', String(input.salePrice));
    form.set('paymentMethod', input.paymentMethod);
    if (input.customerIdImage) form.set('customerIdImage', input.customerIdImage);
    return apiFetch<SaleRecord>('/pos/cash-sales', { method: 'POST', body: form });
  },
  listOrders: (params?: { search?: string; status?: OrderStatus; paymentType?: DesktopOrderPaymentType; page?: number; limit?: number }) => {
    const query = new URLSearchParams();
    if (params?.search) query.set('search', params.search);
    if (params?.status) query.set('status', params.status);
    if (params?.paymentType) query.set('paymentType', params.paymentType);
    if (params?.page) query.set('page', String(params.page));
    if (params?.limit) query.set('limit', String(params.limit));
    return apiFetch<{ items: OrderListItem[]; total: number; page: number; limit: number; totalPages: number }>(`/pos/orders?${query}`);
  },
  createOrder: (data: CreateOrderInput) => apiFetch<OrderDetail>('/pos/orders', { method: 'POST', body: JSON.stringify(data) }),
  createReservation: (input: { customerName: string; customerPhone: string; motorcycleId: string; holdAmount: number; customerIdImage?: File | string }) => {
    if (input.customerIdImage instanceof File) {
      const form = new FormData();
      form.set('customerName', input.customerName);
      form.set('customerPhone', input.customerPhone);
      form.set('motorcycleId', input.motorcycleId);
      form.set('holdAmount', String(input.holdAmount));
      form.set('customerIdImage', input.customerIdImage);
      return apiFetch<CreatePOSTransactionResponse>('/pos/reservations/direct', { method: 'POST', body: form });
    }
    return apiFetch<CreatePOSTransactionResponse>('/pos/reservations/direct', { method: 'POST', body: JSON.stringify(input) });
  },
  getOrder: (id: string) => apiFetch<OrderDetail>(`/pos/orders/${id}`),
  updateOrderStatus: (id: string, status: OrderStatus) => apiFetch<OrderDetail>(`/pos/orders/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) }),
  cancelOrder: (id: string) => apiFetch<OrderDetail>(`/pos/orders/${id}/cancel`, { method: 'POST' }),
  listReservations: (params?: { status?: ReservationStatus; page?: number; limit?: number }) => {
    const query = new URLSearchParams();
    if (params?.status) query.set('status', params.status);
    if (params?.page) query.set('page', String(params.page));
    if (params?.limit) query.set('limit', String(params.limit));
    return apiFetch<{ items: ReservationListItem[]; total: number; page: number; limit: number; totalPages: number }>(`/pos/reservations?${query}`);
  },
  getReservation: (id: string) => apiFetch<ReservationDetail>(`/pos/reservations/${id}`),
  cancelReservation: (id: string, reason?: string) => apiFetch<ReservationDetail>(`/pos/reservations/${id}/cancel`, { method: 'POST', body: JSON.stringify({ reason }) }),
  updateReservation: (id: string, data: { expiresAt?: string; notes?: string }) => apiFetch<ReservationDetail>(`/pos/reservations/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  
  getActiveReservations: (branchId?: string, customerId?: string) => {
    const params = new URLSearchParams();
    if (branchId) params.append('branchId', branchId);
    if (customerId) params.append('customerId', customerId);
    return apiFetch<POSReservation[]>(`/pos/reservations/active?${params}`);
  },
  listActiveReservations: (params?: { branchId?: string; customerId?: string; expiringInDays?: number }) => {
    const query = new URLSearchParams();
    if (params?.branchId) query.set('branchId', params.branchId);
    if (params?.customerId) query.set('customerId', params.customerId);
    if (params?.expiringInDays !== undefined) query.set('expiringInDays', String(params.expiringInDays));
    return apiFetch<POSReservation[]>(`/pos/reservations/active?${query}`);
  },
  convertReservation: (id: string, notes?: string, idempotencyKey?: string) =>
    apiFetch<CreatePOSTransactionResponse>(`/pos/reservations/${id}/convert`, {
      method: 'POST',
      headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined,
      body: JSON.stringify({ notes }),
    }),
  
  getSyncStatus: () => apiFetch<POSSyncStatus>('/pos/offline/sync-status'),
  
  queueOperation: (data: QueueOfflineOperationDto) =>
    apiFetch('/pos/offline/queue', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  getQueuedOperations: () => apiFetch<Array<{ id: string; type: string; data: unknown; status: string; createdAt: string; expiresAt: string }>>('/pos/offline/queue'),
};

// ─── Financing & Installments ────────────────────────────
export type FinancingStatus = 'active' | 'completed' | 'defaulted' | 'cancelled';
export type InstallmentStatus = 'upcoming' | 'due' | 'paid' | 'overdue';
export type InstallmentFrequency = 'monthly' | 'quarterly';

export interface FinancingContractRecord {
  id: string;
  contractNumber: string;
  customerId: string;
  orderId: string;
  totalAmount: number;
  downPayment: number;
  financingAmount: number;
  numberOfInstallments: number;
  installmentFrequency: InstallmentFrequency;
  interestRate: number;
  startDate: string;
  status: FinancingStatus;
  customer?: { id: string; name: string; phone: string };
  order?: { id: string; orderNumber: string };
  installments?: InstallmentRecord[];
}

export interface InstallmentRecord {
  id: string;
  contractId: string;
  installmentNumber: number;
  dueDate: string;
  amount: number;
  paidAmount: number;
  remainingAmount?: number;
  status: InstallmentStatus;
  paidAt?: string | null;
  contract?: FinancingContractRecord;
  customer?: { id: string; name: string; phone: string };
  invoice?: { id: string; invoiceNumber: string };
}

export const financing = {
  list: (params?: { page?: number; limit?: number; status?: FinancingStatus; customerId?: string }) => {
    const q = new URLSearchParams();
    if (params?.page) q.set('page', String(params.page));
    if (params?.limit) q.set('limit', String(params.limit));
    if (params?.status) q.set('status', params.status);
    if (params?.customerId) q.set('customerId', params.customerId);
    return apiFetch<{ items: FinancingContractRecord[]; total: number; page: number; limit: number; totalPages: number }>(`/financing-contracts?${q}`);
  },
  get: (id: string) => apiFetch<FinancingContractRecord>(`/financing-contracts/${id}`),
  approve: (id: string, notes?: string) => apiFetch<FinancingContractRecord>(`/financing-contracts/${id}/approve`, { method: 'PATCH', body: JSON.stringify({ notes }) }),
  updateStatus: (id: string, status: FinancingStatus, notes?: string) => apiFetch<FinancingContractRecord>(`/financing-contracts/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status, notes }) }),
};

export const installments = {
  get: (id: string) => apiFetch<InstallmentRecord>(`/installments/${id}`),
  byContract: (contractId: string) => apiFetch<InstallmentRecord[]>(`/installments/contract/${contractId}`),
  pay: (id: string, data: { amount: number; method: PaymentMethod; reference?: string; idempotencyKey: string; notes?: string }) => apiFetch<PaymentResult>(`/installments/${id}/payments`, { method: 'POST', body: JSON.stringify(data) }),
  updateStatuses: () => apiFetch<{ updated: number }>('/installments/status-update', { method: 'POST' }),
};

// ─── Reports ─────────────────────────────────────────────
export type ReportPreset = 'today' | 'yesterday' | 'this_week' | 'last_week' | 'this_month' | 'last_month' | 'this_quarter' | 'last_quarter' | 'this_year' | 'last_year' | 'custom';
export interface ReportFilters { preset?: ReportPreset; startDate?: string; endDate?: string; branches?: string; }
const reportQuery = (filters?: ReportFilters) => {
  const q = new URLSearchParams();
  if (filters?.preset) q.set('preset', filters.preset);
  if (filters?.startDate) q.set('startDate', filters.startDate);
  if (filters?.endDate) q.set('endDate', filters.endDate);
  if (filters?.branches) q.set('branches', filters.branches);
  return q;
};

export const reports = {
  executive: (filters?: ReportFilters) => apiFetch<any>(`/reports/dashboard/executive?${reportQuery(filters)}`),
  operational: (filters?: ReportFilters) => apiFetch<any>(`/reports/dashboard/operational?${reportQuery(filters)}`),
  sales: (filters?: ReportFilters) => apiFetch<any>(`/reports/sales/summary?${reportQuery(filters)}`),
  inventory: (filters?: ReportFilters) => apiFetch<any>(`/reports/inventory/current-status?${reportQuery(filters)}`),
  installments: (filters?: ReportFilters) => apiFetch<any>(`/reports/installments/portfolio?${reportQuery(filters)}`),
  overdue: (filters?: ReportFilters) => apiFetch<any>(`/reports/installments/overdue?${reportQuery(filters)}`),
  suppliers: (filters?: ReportFilters) => apiFetch<any>(`/reports/suppliers/performance?${reportQuery(filters)}`),
};

// ─── Suppliers ───────────────────────────────────────────
export interface SupplierRecord {
  id: string;
  name: string;
  contactPerson?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  notes?: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SupplierInput { name: string; contactPerson?: string; phone?: string; email?: string; address?: string; notes?: string; isActive?: boolean; }
export const suppliers = {
  list: (params?: { page?: number; limit?: number; search?: string; isActive?: boolean }) => {
    const q = new URLSearchParams();
    if (params?.page) q.set('page', String(params.page));
    if (params?.limit) q.set('limit', String(params.limit));
    if (params?.search) q.set('search', params.search);
    if (params?.isActive !== undefined) q.set('isActive', String(params.isActive));
    return apiFetch<{ items: SupplierRecord[]; meta: { total: number; page: number; limit: number; totalPages: number } }>(`/suppliers?${q}`);
  },
  get: (id: string) => apiFetch<SupplierRecord>(`/suppliers/${id}`),
  create: (data: SupplierInput) => apiFetch<SupplierRecord>('/suppliers', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: string, data: Partial<SupplierInput>) => apiFetch<SupplierRecord>(`/suppliers/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  remove: (id: string) => apiFetch<void>(`/suppliers/${id}`, { method: 'DELETE' }),
};


// ─── Configuration (SPEC-013 TASK-015) ───────────────────
export const configuration = {
  // Get resolved configuration for current user/branch
  getResolvedConfig: (keys?: string[]) => {
    const q = new URLSearchParams();
    if (keys) keys.forEach(k => q.append('keys', k));
    return apiFetch<Record<string, any>>(`/config/resolved?${q}`);
  },
  
  // Get specific configuration value
  getValue: (key: string) =>
    apiFetch<{
      value: any;
      source: 'system' | 'company' | 'branch';
      lastModified: string;
    }>(`/config/value/${key}`),
  
  // Check feature flag status
  checkFeature: (flagKey: string) =>
    apiFetch<{ flagKey: string; isEnabled: boolean }>(`/config/feature/${flagKey}/status`),
};

// ─── Financing Companies ──────────────────────────────────
export interface FinancingCompanyRecord {
  id: string;
  name: string;
  nameAr?: string;
  nameEn?: string;
  whatsappNumber: string;
  isActive: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface FinancingCompanyInput {
  name: string;
  whatsappNumber: string;
  isActive?: boolean;
  sortOrder?: number;
}

/** Public list (active only) — usable in POS dropdowns, Sales page, etc. */
export const financingCompanies = {
  list: () => apiFetch<FinancingCompanyRecord[]>('/financing-companies'),
  listAll: () => apiFetch<FinancingCompanyRecord[]>('/admin/financing-companies'),
  create: (data: FinancingCompanyInput) =>
    apiFetch<FinancingCompanyRecord>('/admin/financing-companies', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  update: (id: string, data: Partial<FinancingCompanyInput>) =>
    apiFetch<FinancingCompanyRecord>(`/admin/financing-companies/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  remove: (id: string) =>
    apiFetch<{ id: string }>(`/admin/financing-companies/${id}`, { method: 'DELETE' }),
};

// ─── New Inquiries (POS) ──────────────────────────────────
export type InquiryDocumentType = 'EMPLOYEE' | 'PENSION' | 'COMMERCIAL_REGISTRY' | 'NEITHER';

export interface InquiryRecord {
  id: string;
  customerName: string;
  customerPhone: string;
  documentType: InquiryDocumentType;
  address?: string | null;
  occupation?: string | null;
  documentImage?: string;
  idCardFrontImage?: string;
  idCardBackImage?: string;
  guarantorIdFrontImage?: string;
  guarantorIdBackImage?: string;
  guarantorSignatureImage?: string;
  downPayment?: number;
  motorcycleId?: string;
  motorcycle?: MotorcycleSearchResult;
  createdBy?: string;
  createdAt: string;
}

export interface InquiryInput {
  customerName: string;
  customerPhone: string;
  documentType: InquiryDocumentType;
  address?: string;
  occupation?: string;
  downPayment?: number;
  motorcycleId?: string;
  documentImage?: File;
  idCardFrontImage?: File;
  idCardBackImage?: File;
  guarantorIdFrontImage?: File;
  guarantorIdBackImage?: File;
  guarantorSignatureImage?: File;
  financingCompanyId?: string;
  installmentDurationId?: string;
}

export interface InstallmentDurationRecord {
  id: string;
  months: number;
  isActive: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export const installmentDurations = {
  list: () => apiFetch<InstallmentDurationRecord[]>('/installment-durations'),
  listAll: () => apiFetch<InstallmentDurationRecord[]>('/admin/installment-durations'),
  create: (data: { months: number; isActive?: boolean; sortOrder?: number }) => apiFetch<InstallmentDurationRecord>('/admin/installment-durations', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: string, data: Partial<InstallmentDurationRecord>) => apiFetch<InstallmentDurationRecord>(`/admin/installment-durations/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  remove: (id: string) => apiFetch<InstallmentDurationRecord>(`/admin/installment-durations/${id}`, { method: 'DELETE' }),
};

export const inquiries = {
  list: () => apiFetch<InquiryRecord[]>('/inquiries'),
  create: (input: InquiryInput) => {
    const form = new FormData();
    form.set('customerName', input.customerName);
    form.set('customerPhone', input.customerPhone);
    form.set('documentType', input.documentType);
    if (input.address) form.set('address', input.address);
    if (input.occupation) form.set('occupation', input.occupation);
    if (input.downPayment !== undefined) form.set('downPayment', String(input.downPayment));
    if (input.motorcycleId) form.set('motorcycleId', input.motorcycleId);
    if (input.financingCompanyId) form.set('financingCompanyId', input.financingCompanyId);
    if (input.installmentDurationId) form.set('installmentDurationId', input.installmentDurationId);
    
    if (input.documentImage) form.set('documentImage', input.documentImage);
    if (input.idCardFrontImage) form.set('idCardFrontImage', input.idCardFrontImage);
    if (input.idCardBackImage) form.set('idCardBackImage', input.idCardBackImage);
    if (input.guarantorIdFrontImage) form.set('guarantorIdFrontImage', input.guarantorIdFrontImage);
    if (input.guarantorIdBackImage) form.set('guarantorIdBackImage', input.guarantorIdBackImage);
    if (input.guarantorSignatureImage) form.set('guarantorSignatureImage', input.guarantorSignatureImage);
    
    return apiFetch<InquiryRecord>('/inquiries', { method: 'POST', body: form });
  },
  sendWhatsApp: (id: string) => apiFetch<{ phone: string; message: string }>(`/inquiries/${id}/send-whatsapp`, { method: 'POST' }),
  sendForReview: (id: string) => apiFetch<unknown>(`/inquiries/${id}/send-for-review`, { method: 'POST' }),
};


// ─── Sales API ────────────────────────────────────────────
export type SalePaymentMethod = 'CASH' | 'VISA';

export interface SaleRecord {
  id: string;
  motorcycleId: string;
  motorcycle: MotorcycleSearchResult;
  customerName: string;
  customerPhone: string;
  customerIdImage?: string;
  salePrice: number;
  paymentMethod: SalePaymentMethod;
  branchId?: string;
  createdAt: string;
}

export interface SaleInput {
  motorcycleId: string;
  customerName: string;
  customerPhone: string;
  salePrice: number;
  paymentMethod: SalePaymentMethod;
  customerIdImage?: File;
}

export const sales = {
  list: (branchId?: string) => {
    const params = branchId ? `?branchId=${branchId}` : '';
    return apiFetch<SaleRecord[]>(`/sales${params}`);
  },
  get: (id: string) => apiFetch<SaleRecord>(`/sales/${id}`),
  create: (input: SaleInput) => {
    const form = new FormData();
    form.set('motorcycleId', input.motorcycleId);
    form.set('customerName', input.customerName);
    form.set('customerPhone', input.customerPhone);
    form.set('salePrice', String(input.salePrice));
    form.set('paymentMethod', input.paymentMethod);
    if (input.customerIdImage) form.set('customerIdImage', input.customerIdImage);
    return apiFetch<SaleRecord>('/sales', { method: 'POST', body: form });
  },
};

// ─── Sales Requests (Installments) ─────────────────────────
export interface SaleRequestRecord {
  id: string;
  customerName: string;
  customerPhone: string;
  motorcycleId: string;
  financingCompanyId: string;
  requestedAmount: number;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  createdAt: string;
}

export interface SaleRequestInput {
  customerName: string;
  customerPhone: string;
  motorcycleId: string;
  financingCompanyId: string;
  requestedAmount: number;
}

export const salesRequests = {
  list: (branchId?: string) => {
    const params = branchId ? `?branchId=${branchId}` : '';
    return apiFetch<SaleRequestRecord[]>(`/sales-requests${params}`);
  },
  create: (input: SaleRequestInput) => 
    apiFetch<SaleRequestRecord>('/sales-requests', {
      method: 'POST',
      body: JSON.stringify(input)
    }),
};

// ─── POS Reservations ─────────────────────────────────────
export interface PosReservationRecord {
  id: string;
  customerName: string;
  customerPhone: string;
  motorcycleId: string;
  holdAmount: number;
  reservationDate: string;
  status: 'ACTIVE' | 'CANCELLED' | 'COMPLETED';
  createdAt: string;
}

export interface PosReservationInput {
  customerName: string;
  customerPhone: string;
  motorcycleId: string;
  holdAmount: number;
}

export const posReservations = {
  list: (branchId?: string) => {
    const params = branchId ? `?branchId=${branchId}` : '';
    return apiFetch<PosReservationRecord[]>(`/pos-reservations${params}`);
  },
  create: (input: PosReservationInput) =>
    apiFetch<PosReservationRecord>('/pos-reservations', {
      method: 'POST',
      body: JSON.stringify(input)
    }),
  cancel: (id: string) =>
    apiFetch<{ id: string; status: string; refundAmount: number; penaltyApplied: boolean }>(`/pos-reservations/${id}/cancel`, {
      method: 'POST'
    }),
};

// ─── POS Installment Plans ─────────────────────────────────────
export interface PosInstallment {
  id: string;
  dueDate: string;
  amount: number;
  paidAmount: number;
  status: 'UNPAID' | 'PARTIAL' | 'PAID';
  paidAt?: string;
}

export interface PosInstallmentPlanRecord {
  id: string;
  customerName: string;
  customerPhone: string;
  motorcycle: MotorcycleSearchResult;
  totalAmount: number;
  paidAmount: number;
  remainingBalance: number;
  status: 'ACTIVE' | 'COMPLETED' | 'DEFAULTED';
  installments: PosInstallment[];
}

export const posInstallments = {
  list: (branchId?: string, query?: string) => {
    let params = '?';
    if (branchId) params += `branchId=${branchId}&`;
    if (query) params += `query=${encodeURIComponent(query)}&`;
    return apiFetch<PosInstallmentPlanRecord[]>(`/pos-installments${params}`);
  },
  generate: (input: { saleRequestId: string; months: number; interestRate: number }) =>
    apiFetch<PosInstallmentPlanRecord>('/pos-installments/generate', {
      method: 'POST',
      body: JSON.stringify(input)
    }),
};

// ─── Desktop Permissions ────────────────────────────────────────────
export interface DesktopPagePermission {
  pageKey: string;
  canView: boolean;
  canEdit: boolean;
}

export const desktopPermissions = {
  /** Get the calling user's own desktop permissions */
  getMe: () => apiFetch<DesktopPagePermission[]>('/desktop-permissions/me'),
  /** Get permissions for a specific user (super_admin only) */
  getForUser: (userId: string) => apiFetch<DesktopPagePermission[]>(`/desktop-permissions/${userId}`),
  /** Bulk-set permissions for a user (super_admin only) */
  setForUser: (userId: string, permissions: DesktopPagePermission[]) =>
    apiFetch<DesktopPagePermission[]>(`/desktop-permissions/${userId}`, {
      method: 'PUT',
      body: JSON.stringify({ permissions }),
    }),
  /** Reset all permissions for a user to defaults (super_admin only) */
  resetForUser: (userId: string) =>
    apiFetch<void>(`/desktop-permissions/${userId}/reset`, { method: 'DELETE' }),
};

// ─── Attendance ─────────────────────────────────────────────────────
export interface AttendanceRecord {
  id: string;
  userId: string;
  userName: string;
  userEmail: string;
  branchId: string | null;
  branchNameEn: string | null;
  branchNameAr: string | null;
  checkIn: string;
  checkOut: string | null;
  notes: string | null;
  createdAt: string;
}

export interface AttendanceListResult {
  items: AttendanceRecord[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export const attendance = {
  checkIn: (notes?: string) =>
    apiFetch<AttendanceRecord>('/attendance/check-in', { method: 'POST', body: JSON.stringify({ notes }) }),
  checkOut: (notes?: string) =>
    apiFetch<AttendanceRecord>('/attendance/check-out', { method: 'POST', body: JSON.stringify({ notes }) }),
  getMe: (params?: { page?: number; limit?: number; startDate?: string; endDate?: string }) => {
    const q = new URLSearchParams();
    if (params?.page) q.set('page', String(params.page));
    if (params?.limit) q.set('limit', String(params.limit));
    if (params?.startDate) q.set('startDate', params.startDate);
    if (params?.endDate) q.set('endDate', params.endDate);
    return apiFetch<AttendanceListResult>(`/attendance/me?${q}`);
  },
  listAll: (params?: { userId?: string; page?: number; limit?: number; startDate?: string; endDate?: string }) => {
    const q = new URLSearchParams();
    if (params?.userId) q.set('userId', params.userId);
    if (params?.page) q.set('page', String(params.page));
    if (params?.limit) q.set('limit', String(params.limit));
    if (params?.startDate) q.set('startDate', params.startDate);
    if (params?.endDate) q.set('endDate', params.endDate);
    return apiFetch<AttendanceListResult>(`/attendance?${q}`);
  },
};


export interface InstallmentRequest {
  id: string;
  customerId: string;
  motorcycleId: string;
  financingCompanyId: string;
  installmentDurationId: string;
  status: 'pending' | 'approved' | 'rejected';
  buyerName: string;
  buyerPhone: string;
  buyerEmail?: string | null;
  buyerAddress?: string | null;
  buyerOccupation?: string | null;
  buyerNationalIdImage: string;
  buyerNationalIdBackImage?: string | null;
  salarySlipImage?: string | null;
  apartmentContractImage?: string | null;
  guarantorName: string;
  guarantorPhone: string;
  guarantorAddress?: string | null;
  guarantorNationalIdImage?: string | null;
  guarantorNationalIdBackImage?: string | null;
  guarantorSignatureImage?: string | null;
  motorcyclePrice: number;
  downPayment: number;
  monthlyInstallment: number;
  durationMonths?: number;
  installmentAmount?: number;
  rejectionReason?: string | null;
  reviewedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  customer?: any;
  motorcycle?: any;
  financingCompany?: any;
  duration?: any;
  inquiry?: { documentType?: InquiryDocumentType | null; address?: string | null; occupation?: string | null };
}

export const customerFinancing = {
  listRequests: (status?: string) => {
    const q = new URLSearchParams();
    if (status) q.set('status', status);
    return apiFetch<InstallmentRequest[]>(`/admin/installment-requests?${q}`);
  },
  reviewRequest: (id: string, data: { status: 'approved' | 'rejected'; rejectionReason?: string }) => apiFetch<InstallmentRequest>(`/admin/installment-requests/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  getRequest: (id: string) => apiFetch<InstallmentRequest>(`/admin/installment-requests/${id}`),
  updateRequest: (id: string, data: { buyerName?: string; buyerPhone?: string; financingCompanyId?: string; downPayment?: number }) => apiFetch<InstallmentRequest>(`/admin/installment-requests/${id}/details`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteRequest: (id: string) => apiFetch<InstallmentRequest>(`/admin/installment-requests/${id}`, { method: 'DELETE' }),
  getWhatsAppMessage: (id: string) => apiFetch<{ phone: string; message: string }>(`/admin/installment-requests/${id}/whatsapp`),
};
