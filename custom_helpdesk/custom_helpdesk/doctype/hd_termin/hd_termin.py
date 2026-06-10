import frappe
from frappe.model.document import Document

COLOR_MAP = {
    "Notdienst": "#8B0000",
    "Urlaub": "#2E7D32",
    "Home Office": "#E57373",
    "Außer Haus": "#F57C00",
    "Remote-Inhouse": "#1565C0",
}


class HDTermin(Document):
    def before_save(self):
        self.color = COLOR_MAP.get(self.type, "#607D8B")
