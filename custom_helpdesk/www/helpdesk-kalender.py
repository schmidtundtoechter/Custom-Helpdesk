import frappe
from frappe.sessions import get_csrf_token


def get_context(context):
    if frappe.session.user == "Guest":
        frappe.throw("Nicht autorisiert", frappe.PermissionError)
    context.no_cache = 1
    context.csrf_token = get_csrf_token()
    context.current_user = frappe.session.user
