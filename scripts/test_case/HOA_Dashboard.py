from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Border, Side, Alignment
from openpyxl.worksheet.datavalidation import DataValidation
from openpyxl.formatting.rule import FormulaRule
from openpyxl.chart import PieChart, BarChart, Reference
from openpyxl.utils import get_column_letter

from pathlib import Path

output = Path("/mnt/data/HOA_Dashboard_QA_Tracker.xlsx")

# -----------------------------
# Test cases based on the user's
# supplied dashboard requirements
# -----------------------------
cases = []

def add(tc, module, scenario, pre, data, steps, expected, priority="High"):
    cases.append([
        tc, module, scenario, pre, data, steps, expected, "",
        "Not Started", priority, "", "", "", ""
    ])

# Setup
add("SET-001","HOA Setup","Verify setup banner is displayed",
    "HOA Board Member account has incomplete setup",
    "2 of 3 setup steps completed",
    "Login → Open HOA Dashboard",
    "“Finish setting up your HOA” banner is displayed with the correct setup progress.")
add("SET-002","HOA Setup","Verify setup progress percentage",
    "2 of 3 setup steps are completed",
    "2 of 3",
    "Open dashboard and inspect setup progress",
    "Dashboard shows 2 of 3 steps completed and 67%.")
add("SET-003","HOA Setup","Verify remaining setup item",
    "2 of 3 setup steps completed",
    "HOA Bank Accounts / Manage HOA Fee / Properties & Units",
    "Review the “Up next” setup item",
    "The actual incomplete setup item is shown as the next step.")
add("SET-004","HOA Setup","Verify 1 remaining indicator",
    "2 of 3 setup steps completed",
    "1 remaining",
    "Open dashboard",
    "Dashboard shows 1 remaining setup step.")
add("SET-005","HOA Setup","Verify completed setup",
    "All three setup steps can be completed",
    "All setup steps complete",
    "Complete HOA Bank Accounts, Manage HOA Fee, and Properties & Units",
    "Progress becomes 3 of 3 / 100% and incomplete setup messaging is removed or updated as designed.")
add("SET-006","HOA Setup","Continue Setup redirection",
    "At least one setup step remains incomplete",
    "Pending setup item",
    "Click Continue Setup",
    "User is redirected to the currently pending setup step.")
add("SET-007","HOA Setup","View full checklist redirection",
    "Setup banner is displayed",
    "Checklist",
    "Click View full checklist",
    "Full HOA setup checklist opens.")
add("SET-008","HOA Setup","Close setup banner",
    "Setup banner is displayed",
    "X button",
    "Click X",
    "Banner closes without changing actual setup completion state.")

# Navigation
nav = [
    ("NAV-001","HOA Bank Accounts","Click HOA Bank Accounts","Setup checklist is accessible","HOA Bank Accounts",
     "Open setup checklist → Click HOA Bank Accounts","Correct HOA Bank Accounts page/route opens."),
    ("NAV-002","Manage HOA Fee","Click Manage HOA Fee","Setup checklist is accessible","Manage HOA Fee",
     "Open setup checklist → Click Manage HOA Fee","Correct Manage HOA Fee page/route opens."),
    ("NAV-003","Properties & Units","Click Properties & Units","Setup checklist is accessible","Properties & Units",
     "Open setup checklist → Click Properties & Units","Correct Properties & Units page/route opens."),
    ("NAV-004","Navigation","Verify HOA context after redirection","User belongs to target HOA","Current HOA",
     "Click each setup item → Inspect destination","Destination keeps the correct HOA/community context."),
    ("NAV-005","Navigation","Verify wrong-module redirection does not occur","All setup links visible","Three setup modules",
     "Open each link one by one","Each link opens only its respective module.")
]
for x in nav: add(*x, priority="Critical" if x[0]=="NAV-005" else "High")

# Date filters
date_cases = [
    ("DATE-001","This Month","Sep 1, 2026 – Sep 30, 2026"),
    ("DATE-002","Last Month","Aug 1, 2026 – Aug 31, 2026"),
    ("DATE-003","Next Month","Oct 1, 2026 – Oct 31, 2026"),
    ("DATE-004","Last 3 Months","Jul 1, 2026 – Sep 30, 2026"),
    ("DATE-005","Last 6 Months","Apr 1, 2026 – Sep 30, 2026"),
    ("DATE-006","Next 6 Months","Oct 1, 2026 – Mar 31, 2027"),
]
for tc, filt, rng in date_cases:
    add(tc,"Dashboard Period",f"Verify {filt} date range",
        "Dashboard is open; test date is September 2026",filt,
        f"Open Dashboard Period filter → Select {filt}",
        f"Dashboard displays exactly {rng}.")
add("DATE-007","Dashboard Period","Change date filter repeatedly",
    "Dashboard has invoice/maintenance data","Multiple date filters",
    "Select each date filter one after another",
    "Dashboard data refreshes correctly for every selected period without stale values.")
add("DATE-008","Dashboard Period","Verify start/end date boundaries",
    "Dashboard date filter available","Records on boundary dates",
    "Test records on start date, end date, one day before, and one day after",
    "Start and end dates are handled according to the selected inclusive period; outside dates are excluded.")
add("DATE-009","Dashboard Period","Verify date/time boundary",
    "Dashboard uses date-based metrics","00:00:00 and 23:59:59 records",
    "Create/test records at start and end of day",
    "Records are included/excluded correctly without timezone/date-boundary errors.")
add("DATE-010","Dashboard Period","No records in selected period",
    "A period with no qualifying records exists","No records",
    "Select period with no records",
    "Cards display zero values rather than stale data.")

# Collection stats
collection = [
    ("COL-001","Verify Total amount","Total qualifying invoice amount"),
    ("COL-002","Verify Collected amount","Collected amount"),
    ("COL-003","Verify Overdue amount","Overdue balance"),
    ("COL-004","Verify Due Today","Invoices due on applicable current date"),
    ("COL-005","Verify Coming Due","Future qualifying invoices"),
    ("COL-006","Verify Partially Paid","Partially paid invoice amounts"),
    ("COL-007","Verify Processing","Invoices in processing status"),
    ("COL-008","Verify Waived Amount","Waived invoice amount"),
    ("COL-009","Verify percentage calculations","Card percentages match underlying amounts"),
    ("COL-010","Verify donut chart values","Chart values match collection cards"),
    ("COL-011","Verify units with overdue balance","Correct number of units with overdue balance"),
    ("COL-012","Verify Past Overdue","Correct past overdue amount"),
    ("COL-013","Verify zero-value cards","$0.00 / 0.0% where applicable"),
    ("COL-014","Verify no duplicate invoice counting","Each qualifying invoice is counted once"),
    ("COL-015","Verify invoice outside selected period","Outside-period invoice does not affect period metric"),
]
for tc, scen, data in collection:
    add(tc,"Collection Stats",scen,
        "Dashboard period selected and invoice data available",data,
        "Open Dashboard → Select date period → Compare dashboard value with source invoice records",
        "Displayed metric exactly matches the qualifying invoice/payment/status data for the selected period.",
        "Critical" if tc in ["COL-014","COL-015"] else "High")

# Card click-through
cards = [
    ("CARD-001","Total","Invoice list","Selected dashboard date range"),
    ("CARD-002","Collected","Invoice list","Status = Collected + selected date"),
    ("CARD-003","Overdue","Invoice list","Status = Overdue + selected date"),
    ("CARD-004","Due Today","Invoice list","Due Today + selected date"),
    ("CARD-005","Coming Due","Invoice list","Coming Due + selected date"),
    ("CARD-006","Partially Paid","Invoice list","Status = Partially Paid + selected date"),
    ("CARD-007","Processing","Invoice list","Status = Processing + selected date"),
    ("CARD-008","Waived Amount","Invoice list","Status = Waived + selected date"),
]
for tc, card, dest, filt in cards:
    add(tc,"Collection Card Navigation",f"Click {card} card",
        "Dashboard has qualifying data",card,
        f"Select a dashboard period → Click {card} card",
        f"User opens {dest} with {filt}.","Critical")
add("CARD-009","Collection Card Navigation","Verify Last 3 Months filter is preserved after clicking Overdue",
    "Dashboard has overdue invoices","Last 3 Months",
    "Select Last 3 Months → Click Overdue",
    "Invoice list opens with Status = Overdue and date range Jul 1, 2026 – Sep 30, 2026.","Critical")

# Maintenance
maintenance = [
    ("MNT-001","Open requests count","Open requests in selected period"),
    ("MNT-002","Resolved requests count","Resolved requests in selected period"),
    ("MNT-003","Total requests","Total qualifying requests"),
    ("MNT-004","Change date filter","Open/resolved metrics recalculate"),
    ("MNT-005","No maintenance requests","Zero request scenario"),
    ("MNT-006","Request outside selected period","Outside-period request"),
]
for tc, scen, data in maintenance:
    add(tc,"Maintenance Requests",scen,
        "Maintenance records exist or can be created",data,
        "Open Dashboard → Select period → Compare Maintenance Requests cards with source requests",
        "Displayed maintenance count matches qualifying request records and selected-period rules.")
add("MNT-007","Maintenance Requests","View All Requests redirection",
    "Dashboard shows maintenance requests","Open/Resolved requests",
    "Click View All Requests",
    "All Maintenance Requests list opens.","High")
add("MNT-008","Maintenance Requests","Verify all requests are accessible",
    "Maintenance Requests page opens","Open + Resolved",
    "Review list",
    "Applicable requests are available in the list.")
add("MNT-009","Maintenance Requests","Open context from dashboard",
    "Open maintenance requests exist","Open",
    "Click Open context/card if clickable",
    "User sees the corresponding open-request list/filter if that interaction is supported.")
add("MNT-010","Maintenance Requests","Resolved context from dashboard",
    "Resolved maintenance requests exist","Resolved",
    "Click Resolved context/card if clickable",
    "User sees the corresponding resolved-request list/filter if that interaction is supported.")

# All time
alltime = [
    ("MNT-011","All Time Overview - Open","Open tickets across entire HOA history"),
    ("MNT-012","All Time Overview - Resolved","Resolved tickets across entire HOA history"),
    ("MNT-013","All Time Overview independent of date filter","Change dashboard period"),
    ("MNT-014","Resolve an open ticket","Open count decreases and resolved count increases"),
    ("MNT-015","Historical ticket outside selected period","Old ticket remains represented in All Time Overview"),
]
for tc, scen, data in alltime:
    add(tc,"All Time Overview",scen,
        "Maintenance history exists",data,
        "Open dashboard → Test All Time Overview → Compare with complete maintenance history",
        "All Time Overview reflects complete HOA maintenance history and is not incorrectly restricted by Dashboard Period.")

# Recent activity
activity_entities = ["Property","Unit","Owner","Invoice","Maintenance Request"]
tc_num = 1
for entity in activity_entities:
    for action in ["Create","Update","Delete"]:
        add(f"ACT-{tc_num:03d}","Recent Activity",f"{action} {entity}",
            f"{entity} exists / action is permitted",f"{action} {entity}",
            f"Perform {action.lower()} action on {entity} → Return/refresh Dashboard",
            f"Recent Activity shows the new {action.lower()} activity for the correct {entity}.")
        tc_num += 1
add(f"ACT-{tc_num:03d}","Recent Activity","Verify newest activity appears first",
    "Multiple recent activities exist","Multiple actions",
    "Perform multiple actions → Open Recent Activity",
    "Activities are ordered according to the product's chronological activity rule, with the newest activity appearing first if that is the defined behavior.")
tc_num += 1
add(f"ACT-{tc_num:03d}","Recent Activity","Verify activity timestamp",
    "Recent Activity contains records","Current action",
    "Perform an action → inspect timestamp",
    "Timestamp/relative time corresponds to the actual action time.")
tc_num += 1
add(f"ACT-{tc_num:03d}","Recent Activity","Verify activity HOA isolation",
    "Two HOAs have separate activity","HOA A / HOA B",
    "Perform activity in HOA B → Login/view HOA A dashboard",
    "HOA B activity does not appear in HOA A Recent Activity.","Critical")

# Security / isolation
for i, area in enumerate(["Collection Stats","Maintenance Requests","Recent Activity","Properties/Units","Owners","Invoices"], 1):
    add(f"SEC-{i:03d}","Data Isolation",f"Verify {area} is isolated by HOA",
        "HOA A and HOA B have separate records", "HOA A / HOA B",
        f"Login to HOA A → Open {area} → Compare against HOA B records",
        "Only authorized/current HOA data is displayed; other HOA data is not exposed.","Critical")

# E2E
add("E2E-001","End-to-End Dashboard","Complete dashboard regression flow",
    "Test HOA has setup, invoices, maintenance, and activity data",
    "Last 3 Months; Overdue; Partially Paid; Maintenance; Activity",
    "Login → verify setup → select Last 3 Months → validate Collection Stats → click Overdue → verify status/date → return → click Partially Paid → verify → open Maintenance → View All Requests → create/update/delete a test record → verify Recent Activity",
    "All dashboard sections, filters, calculations, navigation, and activity updates work consistently end-to-end.","Critical")

headers = ["TC ID","Module","Scenario","Preconditions","Test Data","Steps","Expected Result","Actual Result","Status","Priority","Bug ID","Tester","Evidence","Remarks"]

# -----------------------------
# Workbook
# -----------------------------
wb = Workbook()
ws = wb.active
ws.title = "QA Tracker"

# Header
header_fill = PatternFill("solid", fgColor="1F4E78")
header_font = Font(color="FFFFFF", bold=True)
thin = Side(style="thin", color="D9E1F2")

for c, h in enumerate(headers, 1):
    cell = ws.cell(1, c, h)
    cell.fill = header_fill
    cell.font = header_font
    cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
    cell.border = Border(bottom=thin)

for r, row in enumerate(cases, 2):
    for c, value in enumerate(row, 1):
        cell = ws.cell(r, c, value)
        cell.alignment = Alignment(vertical="top", wrap_text=True)
        cell.border = Border(bottom=thin)

# Freeze/filter
ws.freeze_panes = "A2"
ws.auto_filter.ref = f"A1:N{ws.max_row}"

# Widths
widths = {
    "A":12, "B":24, "C":38, "D":34, "E":28, "F":52,
    "G":62, "H":42, "I":16, "J":14, "K":14, "L":18, "M":26, "N":32
}
for col, width in widths.items():
    ws.column_dimensions[col].width = width

for r in range(2, ws.max_row + 1):
    ws.row_dimensions[r].height = 55

# Dropdowns
status_dv = DataValidation(type="list", formula1='"Not Started,Pass,Fail,Blocked,Not Applicable,Retest"', allow_blank=False)
priority_dv = DataValidation(type="list", formula1='"Critical,High,Medium,Low"', allow_blank=False)
ws.add_data_validation(status_dv)
ws.add_data_validation(priority_dv)
status_dv.add(f"I2:I{ws.max_row}")
priority_dv.add(f"J2:J{ws.max_row}")

# Conditional formatting
ws.conditional_formatting.add(
    f"I2:I{ws.max_row}",
    FormulaRule(formula=['I2="Pass"'], fill=PatternFill("solid", fgColor="C6EFCE"))
)
ws.conditional_formatting.add(
    f"I2:I{ws.max_row}",
    FormulaRule(formula=['I2="Fail"'], fill=PatternFill("solid", fgColor="FFC7CE"))
)
ws.conditional_formatting.add(
    f"I2:I{ws.max_row}",
    FormulaRule(formula=['I2="Blocked"'], fill=PatternFill("solid", fgColor="FFEB9C"))
)
ws.conditional_formatting.add(
    f"J2:J{ws.max_row}",
    FormulaRule(formula=['J2="Critical"'], fill=PatternFill("solid", fgColor="F4CCCC"))
)

# Summary dashboard
dash = wb.create_sheet("Summary Dashboard")
dash["A1"] = "HOA Board Member Dashboard - QA Summary"
dash["A1"].font = Font(size=18, bold=True)
dash.merge_cells("A1:D1")

metrics = [
    ("Total Test Cases", f"=COUNTA('QA Tracker'!A2:A{ws.max_row})"),
    ("Executed", f'=COUNTIF(\'QA Tracker\'!I2:I{ws.max_row},"Pass")+COUNTIF(\'QA Tracker\'!I2:I{ws.max_row},"Fail")+COUNTIF(\'QA Tracker\'!I2:I{ws.max_row},"Blocked")+COUNTIF(\'QA Tracker\'!I2:I{ws.max_row},"Retest")+COUNTIF(\'QA Tracker\'!I2:I{ws.max_row},"Not Applicable")'),
    ("Passed", f'=COUNTIF(\'QA Tracker\'!I2:I{ws.max_row},"Pass")'),
    ("Failed", f'=COUNTIF(\'QA Tracker\'!I2:I{ws.max_row},"Fail")'),
    ("Blocked", f'=COUNTIF(\'QA Tracker\'!I2:I{ws.max_row},"Blocked")'),
    ("Not Started", f'=COUNTIF(\'QA Tracker\'!I2:I{ws.max_row},"Not Started")'),
    ("Pass Rate", '=IF(B3=0,0,B4/B3)'),
    ("Execution Rate", '=IF(B2=0,0,(B3+B4+B5+B6+B7)/B2)'),
    ("Critical Test Cases", f'=COUNTIF(\'QA Tracker\'!J2:J{ws.max_row},"Critical")'),
    ("Critical Failures", f'=COUNTIFS(\'QA Tracker\'!J2:J{ws.max_row},"Critical",\'QA Tracker\'!I2:I{ws.max_row},"Fail")'),
]
for idx, (label, formula) in enumerate(metrics, 2):
    dash.cell(idx, 1, label).font = Font(bold=True)
    dash.cell(idx, 2, formula)
    dash.cell(idx, 1).fill = PatternFill("solid", fgColor="D9EAF7")
    dash.cell(idx, 1).border = Border(bottom=thin)
    dash.cell(idx, 2).border = Border(bottom=thin)

dash["B8"].number_format = "0.0%"
dash["B9"].number_format = "0.0%"

# Module coverage summary
start = 14
dash.cell(start,1,"Module").font = Font(bold=True, color="FFFFFF")
dash.cell(start,2,"Total").font = Font(bold=True, color="FFFFFF")
dash.cell(start,3,"Pass").font = Font(bold=True, color="FFFFFF")
dash.cell(start,4,"Fail").font = Font(bold=True, color="FFFFFF")
dash.cell(start,5,"Coverage / Execution").font = Font(bold=True, color="FFFFFF")
for c in range(1,6):
    dash.cell(start,c).fill = header_fill

modules = sorted(set(row[1] for row in cases))
for i, module in enumerate(modules, start+1):
    dash.cell(i,1,module)
    dash.cell(i,2,f'=COUNTIF(\'QA Tracker\'!B2:B{ws.max_row},A{i})')
    dash.cell(i,3,f'=COUNTIFS(\'QA Tracker\'!B2:B{ws.max_row},A{i},\'QA Tracker\'!I2:I{ws.max_row},"Pass")')
    dash.cell(i,4,f'=COUNTIFS(\'QA Tracker\'!B2:B{ws.max_row},A{i},\'QA Tracker\'!I2:I{ws.max_row},"Fail")')
    dash.cell(i,5,f'=IF(B{i}=0,0,(C{i}+D{i})/B{i})')
    dash.cell(i,5).number_format = "0.0%"

for col, width in {"A":30,"B":16,"C":16,"D":16,"E":24}.items():
    dash.column_dimensions[col].width = width
dash.freeze_panes = "A15"

# Chart
chart = BarChart()
chart.title = "Pass / Fail by Module"
chart.y_axis.title = "Test Cases"
chart.x_axis.title = "Module"
data = Reference(dash, min_col=3, max_col=4, min_row=start, max_row=start+len(modules))
cats = Reference(dash, min_col=1, min_row=start+1, max_row=start+len(modules))
chart.add_data(data, titles_from_data=True)
chart.set_categories(cats)
chart.height = 10
chart.width = 22
dash.add_chart(chart, "G14")

# Test data / rules sheet
info = wb.create_sheet("Test Reference")
info_rows = [
    ("Purpose","QA tracker for HOA Board Member Dashboard"),
    ("Dashboard period","Date-based dashboard metrics should reflect the selected period."),
    ("Current test month","September 2026"),
    ("This Month","Sep 1, 2026 – Sep 30, 2026"),
    ("Last Month","Aug 1, 2026 – Aug 31, 2026"),
    ("Next Month","Oct 1, 2026 – Oct 31, 2026"),
    ("Last 3 Months","Jul 1, 2026 – Sep 30, 2026"),
    ("Last 6 Months","Apr 1, 2026 – Sep 30, 2026"),
    ("Next 6 Months","Oct 1, 2026 – Mar 31, 2027"),
    ("Setup items","HOA Bank Accounts; Manage HOA Fee; Properties & Units"),
    ("Maintenance","Open / Resolved current-period metrics plus All Time Overview"),
    ("Recent Activity","Validate create, update, and delete activity for relevant entities"),
    ("Card navigation","Clicking a Collection Stats card should preserve the selected date range and apply the relevant status/context."),
    ("Critical distinction","All Time Overview should represent complete maintenance history if that is the intended product definition.")
]
for r, (k,v) in enumerate(info_rows,1):
    info.cell(r,1,k).font = Font(bold=True)
    info.cell(r,2,v)
    info.cell(r,1).fill = PatternFill("solid", fgColor="D9EAF7")
    info.cell(r,2).alignment = Alignment(wrap_text=True, vertical="top")
info.column_dimensions["A"].width = 28
info.column_dimensions["B"].width = 90

# Footer metadata
ws.sheet_view.showGridLines = False
dash.sheet_view.showGridLines = False
info.sheet_view.showGridLines = False

wb.save(output)

print(f"Created: {output}")
print(f"Test cases: {len(cases)}")
