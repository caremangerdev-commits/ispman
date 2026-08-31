export type Role =
  | 'super_admin'
  | 'company_admin'
  | 'manager'
  | 'csr'
  | 'cashier'
  | 'technician'

export type Permission =
  | 'view_dashboard_kpis'
  | 'view_customer_list'
  | 'view_customer_billing_history'
  | 'view_customer_tech_info'
  | 'add_customer'
  | 'edit_customer'
  | 'activate_customer'
  | 'provision_customer'
  | 'extend_disconnect_customer'
  | 'record_payment'
  | 'view_all_payments'
  | 'edit_payment'
  | 'delete_payment'
  | 'view_checkoff'
  | 'view_revenue_reports'
  | 'view_support_tickets'
  | 'create_ticket'
  | 'edit_ticket'
  | 'assign_ticket'
  | 'resolve_ticket'
  | 'reopen_ticket'
  | 'view_network_infrastructure'
  | 'view_nas_management'
  | 'manage_users'
  | 'manage_company_settings'
  | 'view_super_admin_dashboard'
  | 'assign_company_admin'

const PERMISSIONS: Record<Permission, Role[]> = {
  view_dashboard_kpis: ['super_admin', 'company_admin', 'manager'],
  view_customer_list: ['super_admin', 'company_admin', 'manager', 'csr'],
  view_customer_billing_history: ['super_admin', 'company_admin', 'manager', 'csr', 'cashier', 'technician'],
  view_customer_tech_info: ['super_admin', 'company_admin', 'manager', 'csr', 'technician'],
  add_customer: ['super_admin', 'company_admin', 'manager', 'csr', 'technician'],
  edit_customer: ['super_admin', 'company_admin', 'manager', 'csr', 'technician'],
  activate_customer: ['super_admin', 'company_admin', 'manager', 'csr'],
  // Creating a subscriber's radcheck rows for the first time is a CSR and
  // management action. Deliberately excludes cashier (billing only) and
  // technician (no authority to put an account on the network).
  provision_customer: ['super_admin', 'company_admin', 'manager', 'csr'],
  extend_disconnect_customer: ['super_admin', 'company_admin', 'manager', 'csr'],
  record_payment: ['super_admin', 'company_admin', 'manager', 'csr', 'cashier', 'technician'],
  view_all_payments: ['super_admin', 'company_admin', 'manager', 'csr', 'cashier'],
  // Correcting a recorded payment is a management action: a cashier may take a
  // payment but may not go back and restate one.
  edit_payment: ['super_admin', 'company_admin', 'manager'],
  // Destroying the record of money received is the narrowest right in the app.
  delete_payment: ['super_admin', 'company_admin'],
  view_checkoff: ['super_admin', 'company_admin', 'manager'],
  view_revenue_reports: ['super_admin', 'company_admin', 'manager'],
  // Cashier included deliberately: they already see tickets on a customer
  // record, so excluding them from the dashboard panel only made the two
  // surfaces disagree.
  view_support_tickets: ['super_admin', 'company_admin', 'manager', 'csr', 'cashier', 'technician'],
  // Every role raises, edits, assigns and resolves. Support work is not
  // rank-gated here the way money is: whoever takes the call owns the
  // ticket. Reopen is named separately from resolve so undoing a colleague's
  // resolution can be narrowed later without touching the other three.
  create_ticket: ['super_admin', 'company_admin', 'manager', 'csr', 'cashier', 'technician'],
  edit_ticket: ['super_admin', 'company_admin', 'manager', 'csr', 'cashier', 'technician'],
  assign_ticket: ['super_admin', 'company_admin', 'manager', 'csr', 'cashier', 'technician'],
  resolve_ticket: ['super_admin', 'company_admin', 'manager', 'csr', 'cashier', 'technician'],
  reopen_ticket: ['super_admin', 'company_admin', 'manager', 'csr', 'cashier', 'technician'],
  view_network_infrastructure: ['super_admin', 'company_admin', 'manager', 'csr', 'technician'],
  view_nas_management: ['super_admin', 'company_admin', 'manager'],
  // Manager included: they run the team day to day. The guardrails that matter
  // live in app/actions/users.ts and are checked against the TARGET row, not
  // the caller — nobody may touch their own account, an admin row, or hand out
  // an admin role, whichever role they hold.
  manage_users: ['super_admin', 'company_admin', 'manager'],
  manage_company_settings: ['super_admin', 'company_admin', 'manager'],
  view_super_admin_dashboard: ['super_admin'],
  assign_company_admin: ['super_admin'],
}

export function can(role: Role, permission: Permission): boolean {
  return PERMISSIONS[permission]?.includes(role) ?? false
}

export function canAny(role: Role, permissions: Permission[]): boolean {
  return permissions.some((p) => can(role, p))
}

export const ROLES: Role[] = [
  'super_admin', 'company_admin', 'manager', 'csr', 'cashier', 'technician',
]

/** Human labels for the UI. */
export const ROLE_LABELS: Record<Role, string> = {
  super_admin: 'Super Admin',
  company_admin: 'Company Admin',
  manager: 'Manager',
  csr: 'CSR',
  cashier: 'Cashier',
  technician: 'Technician',
}

const VALID_ROLES = new Set<string>(ROLES)

/**
 * Coerces whatever is stored in `users.role` to a known Role.
 *
 * The column is a plain varchar, so legacy or mistyped values are possible.
 * Anything unrecognised falls back to the least-privileged role rather than
 * defaulting open.
 */
export function toRole(value: string | null | undefined): Role {
  return VALID_ROLES.has(value ?? '') ? (value as Role) : 'technician'
}
