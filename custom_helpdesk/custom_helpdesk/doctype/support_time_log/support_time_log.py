import frappe
from frappe.model.document import Document
from frappe.utils import now_datetime, time_diff_in_hours


class SupportTimeLog(Document):
    def before_save(self):
        self._calculate_duration()
        self._calculate_effective_duration()
        self._calculate_total_cost()
        if not self.entered_by:
            self.entered_by = frappe.session.user

    def _calculate_duration(self):
        if self.start_time and self.end_time:
            hours = time_diff_in_hours(self.end_time, self.start_time)
            self.duration = round(max(hours, 0), 4)

    def _calculate_effective_duration(self):
        if self.manual_override:
            self.effective_duration = self.manual_override
        else:
            self.effective_duration = self.duration or 0

    def _calculate_total_cost(self):
        if self.price_category and self.effective_duration:
            price = frappe.db.get_value(
                "Support Price Category", self.price_category, "price_per_hour"
            ) or 0
            multiplier = int(self.multiplier or 1)
            self.total_cost = self.effective_duration * multiplier * price
        else:
            self.total_cost = 0
