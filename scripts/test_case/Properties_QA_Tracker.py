from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Border, Side, Alignment
from openpyxl.worksheet.datavalidation import DataValidation
from openpyxl.formatting.rule import FormulaRule
from openpyxl.chart import BarChart, PieChart, Reference
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.table import Table, TableStyleInfo
from openpyxl.workbook.properties import CalcProperties

file_path = "/mnt/data/PropMV_Properties_QA_Tracker.xlsx"

wb = Workbook()
ws = wb.active
ws.title = "QA Tracker"

# Palette
navy = "1F4E78"
blue = "D9EAF7"
light_blue = "EAF3F8"
green = "E2F0D9"
red = "F4CCCC"
yellow = "FFF2CC"
orange = "FCE4D6"
gray = "E7E6E6"
white = "FFFFFF"
dark = "1F1F1F"

thin = Side(style="thin", color="B7B7B7")

headers = [
    "TC ID","Module","Scenario","Preconditions","Test Data","Steps",
    "Expected Result","Actual Result","Status","Priority","Bug ID",
    "Tester","Evidence","Remarks"
]
ws.append(headers)

test_cases = [
("PROP-LIST-001","Listing","Open Properties page","User logged in with property access","Valid user","Login > Open Properties","Properties page loads successfully"),
("PROP-LIST-002","Listing","Verify property records","Properties exist","Multiple properties","Open Properties","All authorized properties are displayed"),
("PROP-LIST-003","Listing","Verify table columns","Properties page open","N/A","Check table headers","Property / Unit, Address, Owner, Credit Balance, Overdue Balance, Maintenance are displayed"),
("PROP-LIST-004","Listing","Verify Property / Unit","Property/unit exists","Property + Unit","Compare UI with source data","Correct property/unit is displayed"),
("PROP-LIST-005","Listing","Verify Address","Property exists","Valid address","Compare UI with property details","Correct address is displayed"),
("PROP-LIST-006","Listing","Verify Owner","Owner assigned","Owner data","Compare UI with source","Correct owner is displayed"),
("PROP-LIST-007","Listing","Verify Credit Balance","Property has credit","Credit balance","Compare UI with ledger/source","Correct credit balance is displayed"),
("PROP-LIST-008","Listing","Verify Overdue Balance","Property has overdue amount","Invoice + payment","Compare UI with invoice/source","Correct overdue balance is displayed"),
("PROP-LIST-009","Listing","Verify Maintenance","Maintenance record exists","Maintenance ticket","Compare listing with ticket","Correct maintenance information is displayed"),
("PROP-LIST-010","Listing","Verify multiple properties","Multiple properties exist","5+ properties","Open listing","Each row contains correct property-specific data"),

("PROP-SRCH-001","Search","Exact Property search","Property exists","Property name","Enter property name","Correct property is returned"),
("PROP-SRCH-002","Search","Partial Property search","Property exists","Partial name","Enter partial name","Matching properties are returned"),
("PROP-SRCH-003","Search","Exact Unit search","Unit exists","Unit number","Enter unit number","Correct unit/property is returned"),
("PROP-SRCH-004","Search","Partial Unit search","Unit exists","Partial unit","Search","Matching units are returned"),
("PROP-SRCH-005","Search","Address search","Address exists","Street/address","Search","Correct property is returned"),
("PROP-SRCH-006","Search","Partial Address search","Address exists","Partial address","Search","Matching properties are returned"),
("PROP-SRCH-007","Search","Owner search","Owner exists","Owner name","Search","Correct owner/property is returned"),
("PROP-SRCH-008","Search","Partial Owner search","Owner exists","Partial owner","Search","Matching records are returned"),
("PROP-SRCH-009","Search","Case-insensitive search","Property exists","Upper/lower case","Search using different casing","Correct results are returned"),
("PROP-SRCH-010","Search","Search no results","N/A","Invalid value","Search","Correct empty state is displayed"),
("PROP-SRCH-011","Search","Clear search","Search active","Existing search","Clear search","Full listing is restored"),
("PROP-SRCH-012","Search","Search with spaces","Property exists","  Property A  ","Search","Spaces are handled correctly"),

("PROP-FLT-001","Filter","Open filter","Properties page open","N/A","Click Filter","Filter opens successfully"),
("PROP-FLT-002","Filter","Filter by Property","Properties exist","Property A","Select Property A","Only applicable records are displayed"),
("PROP-FLT-003","Filter","Filter by Unit","Units exist","Unit 101","Select Unit","Correct unit is displayed"),
("PROP-FLT-004","Filter","Property + Unit filter","Property/unit exist","Property A + Unit 101","Apply both","Correct combination is displayed"),
("PROP-FLT-005","Filter","Clear filter","Filter active","Existing filter","Clear filter","Full listing is restored"),
("PROP-FLT-006","Filter","Filter no results","N/A","Nonmatching combination","Apply filter","Correct empty state is displayed"),
("PROP-FLT-007","Filter","Filter + Search","Data exists","Property + search text","Apply both","Results satisfy both conditions"),

("PROP-REF-001","Refresh","Click Refresh","Properties page open","N/A","Click Refresh","Latest property data is loaded"),
("PROP-REF-002","Refresh","Refresh after property creation","Property created","New property","Create property > Refresh","New property appears"),
("PROP-REF-003","Refresh","Refresh after property edit","Property edited","Updated property","Edit > Refresh","Updated data appears"),
("PROP-REF-004","Refresh","Multiple rapid refreshes","Properties page open","N/A","Click Refresh repeatedly","No duplicate requests/data corruption"),
("PROP-REF-005","Refresh","Refresh during API failure","API failure","500/timeout","Click Refresh","Proper error state is displayed"),

("PROP-EXP-001","Export","Export Units","Properties/units exist","N/A","Click Export Units","Export starts successfully"),
("PROP-EXP-002","Export","Verify all units","Units exist","Multiple units","Export","All authorized units are included"),
("PROP-EXP-003","Export","Verify Property / Unit","Units exist","N/A","Compare export with UI/source","Export matches UI/source"),
("PROP-EXP-004","Export","Verify Address","Properties exist","N/A","Compare export with source","Export matches source"),
("PROP-EXP-005","Export","Verify Owner","Owners exist","N/A","Compare export with source","Export matches source"),
("PROP-EXP-006","Export","Export after filter","Filter active","Filtered units","Apply filter > Export","Export follows defined filter behavior"),
("PROP-EXP-007","Export","Export with no results","No matching data","N/A","Search/filter to zero > Export","Correct behavior/message is displayed"),
("PROP-EXP-008","Export","Open exported file","Export completed","Generated file","Open file","File opens without corruption"),
("PROP-EXP-009","Export","Duplicate records","Multiple units","N/A","Export > inspect rows","No unexpected duplicate records"),

("PROP-EDIT-001","Edit","Open property edit","Property exists","Property A","Open Edit","Correct property opens"),
("PROP-EDIT-002","Edit","Verify existing data","Property exists","Existing values","Open Edit","Current values are populated correctly"),
("PROP-EDIT-003","Edit","Update property","Property exists","Valid changes","Edit > Save","Changes save successfully"),
("PROP-EDIT-004","Edit","Cancel edit","Property exists","Temporary changes","Edit > Cancel","Changes are not saved"),
("PROP-EDIT-005","Edit","Invalid data","Property exists","Invalid value","Enter invalid data > Save","Validation is displayed"),
("PROP-EDIT-006","Edit","Refresh after edit","Property edited","Updated property","Edit > Save > Refresh","Updated listing is displayed"),

("PROP-NOTE-001","Notes","Add note","Property exists","Valid note","Open notes > Add > Save","Note is saved successfully"),
("PROP-NOTE-002","Notes","Edit note","Note exists","Updated note","Edit > Save","Updated note is displayed"),
("PROP-NOTE-003","Notes","Delete note","Note exists","Existing note","Delete note","Note is removed as expected"),
("PROP-NOTE-004","Notes","Empty note","Property exists","Blank note","Submit blank note","Validation is displayed"),
("PROP-NOTE-005","Notes","Verify property association","Multiple properties","Property-specific note","Add note > inspect property","Note belongs to the correct property"),

("PROP-DATA-001","Data Accuracy","Zero balance","Invoice fully paid","Invoice $100 / Paid $100","Compare UI with source","Credit $0 / Overdue $0"),
("PROP-DATA-002","Data Accuracy","Partial payment","Invoice partially paid","Invoice $150 / Paid $100","Compare UI with source","Balance follows defined overdue business rule"),
("PROP-DATA-003","Data Accuracy","Credit balance","Overpayment exists","Invoice $100 / Payment $120","Compare UI with source","Credit Balance = $20"),
("PROP-DATA-004","Data Accuracy","Multiple invoices","Multiple invoices exist","$100 + $200 + $300","Compare aggregate with source","Correct aggregate balance is displayed"),
("PROP-DATA-005","Data Accuracy","Multiple payments","Multiple payments exist","Multiple payments","Compare aggregate with source","Correct calculated balance is displayed"),
("PROP-DATA-006","Data Accuracy","Overdue invoice","Past-due invoice exists","Unpaid overdue invoice","Compare UI with source","Correct overdue amount is displayed"),
("PROP-DATA-007","Data Accuracy","Multiple units","Property has 3 units","Units 101/102/103","Compare rows with source","No incorrect duplication/aggregation"),
("PROP-DATA-008","Data Accuracy","Owner with multiple properties","Owner owns multiple properties","Owner + properties","Compare relationships","Correct owner/property relationship"),
("PROP-DATA-009","Data Accuracy","Maintenance ticket exists","Ticket exists","Open maintenance ticket","Compare listing with ticket","Correct maintenance status is displayed"),
("PROP-DATA-010","Data Accuracy","No maintenance ticket","No ticket exists","N/A","Compare listing with source","Correct empty/default state"),

("PROP-REG-001","Regression","Search > Edit > Refresh","Property exists","Property A","Search > Edit > Refresh","Updated property remains correct"),
("PROP-REG-002","Regression","Search > Open Property > Back","Property exists","Property A","Search > Open > Back","Listing/search state behaves correctly"),
("PROP-REG-003","Regression","Filter > Search","Data exists","Filter + search","Apply filter > search","Correct intersection of conditions"),
("PROP-REG-004","Regression","Search > Clear > Filter","Data exists","Search + filter","Search > clear > filter","Correct filtered results"),
("PROP-REG-005","Regression","Edit > Refresh","Property exists","Updated value","Edit > Refresh","Updated information is displayed"),
("PROP-REG-006","Regression","Add Note > Refresh","Property exists","New note","Add note > Refresh","Note persists"),
("PROP-REG-007","Regression","Create Property > Search","Property creation allowed","New property","Create > Search","New property is searchable"),
("PROP-REG-008","Regression","Create Property > Edit > Search","Property exists","New property","Create > Edit > Search","Updated property is searchable"),
("PROP-REG-009","Regression","Overdue > Payment > Refresh","Overdue invoice exists","Payment","Record payment > Refresh","Balance updates correctly"),
("PROP-REG-010","Regression","Credit > Apply Credit > Refresh","Credit exists","Credit application","Apply credit > Refresh","Credit updates correctly"),
("PROP-REG-011","Regression","Filter > Export","Filtered records exist","Filter","Filter > Export","Export follows expected filter behavior"),
("PROP-REG-012","Regression","Search > Export","Search results exist","Search","Search > Export","Export follows expected search behavior"),
]

# Append rows with defaults
priorities = {
    "Listing":"P0","Search":"P0","Filter":"P0","Refresh":"P0","Export":"P0",
    "Edit":"P0","Notes":"P0","Data Accuracy":"P0","Regression":"P0"
}
for tc in test_cases:
    row = list(tc) + ["", "", "Not Tested", priorities.get(tc[1], "P1"), "", "", "", "", ""]
    ws.append(row)

# Style header
for cell in ws[1]:
    cell.fill = PatternFill("solid", fgColor=navy)
    cell.font = Font(color=white, bold=True)
    cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
    cell.border = Border(bottom=thin)

ws.freeze_panes = "A2"
ws.auto_filter.ref = f"A1:N{ws.max_row}"
ws.sheet_view.showGridLines = False

widths = [18,16,32,30,28,38,42,36,16,12,14,18,24,30]
for i,w in enumerate(widths,1):
    ws.column_dimensions[get_column_letter(i)].width = w

for row in ws.iter_rows(min_row=2, max_row=ws.max_row):
    for cell in row:
        cell.alignment = Alignment(vertical="top", wrap_text=True)
        cell.border = Border(bottom=thin)

# Table
tab = Table(displayName="QATracker", ref=f"A1:N{ws.max_row}")
tab.tableStyleInfo = TableStyleInfo(name="TableStyleMedium2", showRowStripes=True, showFirstColumn=False, showLastColumn=False)
ws.add_table(tab)

# Data validations
status_dv = DataValidation(type="list", formula1='"Not Tested,In Progress,Passed,Failed,Blocked,Not Applicable,Retest Required"', allow_blank=False)
priority_dv = DataValidation(type="list", formula1='"P0,P1,P2"', allow_blank=False)
ws.add_data_validation(status_dv); status_dv.add(f"I2:I{ws.max_row}")
ws.add_data_validation(priority_dv); priority_dv.add(f"J2:J{ws.max_row}")

# Conditional formatting
status_colors = {
    "Passed": green, "Failed": red, "Blocked": orange,
    "In Progress": yellow, "Not Tested": gray, "Retest Required": orange,
    "Not Applicable": blue
}
for status, color in status_colors.items():
    ws.conditional_formatting.add(
        f"I2:I{ws.max_row}",
        FormulaRule(formula=[f'$I2="{status}"'], fill=PatternFill("solid", fgColor=color))
    )
for p,color in [("P0",red),("P1",yellow),("P2",green)]:
    ws.conditional_formatting.add(
        f"J2:J{ws.max_row}",
        FormulaRule(formula=[f'$J2="{p}"'], fill=PatternFill("solid", fgColor=color))
    )

# Dashboard
dash = wb.create_sheet("Summary Dashboard")
dash.sheet_view.showGridLines = False
dash["A1"] = "PropMV — Properties QA Summary Dashboard"
dash["A1"].font = Font(size=18, bold=True, color=white)
dash["A1"].fill = PatternFill("solid", fgColor=navy)
dash.merge_cells("A1:H1")
dash["A2"] = "Automatic metrics update from the QA Tracker sheet."
dash.merge_cells("A2:H2")
dash["A2"].font = Font(italic=True, color="666666")

metrics = [
    ("Total Test Cases", '=COUNTA(\'QA Tracker\'!A2:A1000)'),
    ("Executed", '=COUNTIF(\'QA Tracker\'!I2:I1000,"Passed")+COUNTIF(\'QA Tracker\'!I2:I1000,"Failed")+COUNTIF(\'QA Tracker\'!I2:I1000,"Blocked")+COUNTIF(\'QA Tracker\'!I2:I1000,"Not Applicable")+COUNTIF(\'QA Tracker\'!I2:I1000,"Retest Required")'),
    ("Passed", '=COUNTIF(\'QA Tracker\'!I2:I1000,"Passed")'),
    ("Failed", '=COUNTIF(\'QA Tracker\'!I2:I1000,"Failed")'),
    ("Blocked", '=COUNTIF(\'QA Tracker\'!I2:I1000,"Blocked")'),
    ("Not Tested", '=COUNTIF(\'QA Tracker\'!I2:I1000,"Not Tested")'),
    ("In Progress", '=COUNTIF(\'QA Tracker\'!I2:I1000,"In Progress")'),
    ("Retest Required", '=COUNTIF(\'QA Tracker\'!I2:I1000,"Retest Required")'),
    ("Coverage %", '=IFERROR(B4/B3,0)'),
    ("Pass Rate %", '=IFERROR(B5/B4,0)'),
    ("Open P0 Bugs", '=COUNTIFS(\'QA Tracker\'!J2:J1000,"P0",\'QA Tracker\'!I2:I1000,"Failed")+COUNTIFS(\'QA Tracker\'!J2:J1000,"P0",\'QA Tracker\'!I2:I1000,"Blocked")'),
    ("P0 Executed", '=COUNTIFS(\'QA Tracker\'!J2:J1000,"P0",\'QA Tracker\'!I2:I1000,"<>Not Tested",\'QA Tracker\'!I2:I1000,"<>In Progress")'),
    ("P0 Passed", '=COUNTIFS(\'QA Tracker\'!J2:J1000,"P0",\'QA Tracker\'!I2:I1000,"Passed")'),
    ("P0 Pass %", '=IFERROR(B15/B14,0)'),
]
dash["A3"]="Metric"; dash["B3"]="Value"
for c in dash[3]:
    c.fill = PatternFill("solid", fgColor=navy); c.font=Font(color=white,bold=True)
for r,(name,formula) in enumerate(metrics,4):
    dash.cell(r,1,name); dash.cell(r,2,formula)
    dash.cell(r,1).font = Font(bold=True)
    dash.cell(r,1).fill = PatternFill("solid", fgColor=light_blue)
    dash.cell(r,2).fill = PatternFill("solid", fgColor=white)
    dash.cell(r,1).border = dash.cell(r,2).border = Border(bottom=thin)
dash["B12"].number_format="0.00%"
dash["B13"].number_format="0.00%"
dash["B17"].number_format="0.00%"

# Readiness gate
dash["D3"]="Production Gate"
dash["D3"].fill=PatternFill("solid",fgColor=navy); dash["D3"].font=Font(color=white,bold=True)
dash["D4"]="P0 Pass = 100%"
dash["E4"]='=IF(B17=1,"PASS","NOT READY")'
dash["D5"]="Open P0 Bugs = 0"
dash["E5"]='=IF(B14=0,"PASS","NOT READY")'
dash["D6"]="Coverage = 100%"
dash["E6"]='=IF(B12=1,"PASS","INCOMPLETE")'
dash["D7"]="Overall Gate"
dash["E7"]='=IF(AND(B17=1,B14=0,B12=1),"READY FOR PRODUCTION","NOT READY")'
for r in range(4,8):
    dash.cell(r,4).font=Font(bold=True)
    dash.cell(r,4).fill=PatternFill("solid",fgColor=blue)
    dash.cell(r,5).font=Font(bold=True)

dash.conditional_formatting.add("E4:E7", FormulaRule(formula=['ISNUMBER(SEARCH("PASS",$E4))'], fill=PatternFill("solid",fgColor=green)))
dash.conditional_formatting.add("E4:E7", FormulaRule(formula=['ISNUMBER(SEARCH("READY",$E4))'], fill=PatternFill("solid",fgColor=green)))
dash.conditional_formatting.add("E4:E7", FormulaRule(formula=['ISNUMBER(SEARCH("NOT",$E4))'], fill=PatternFill("solid",fgColor=red)))
dash.conditional_formatting.add("E4:E7", FormulaRule(formula=['ISNUMBER(SEARCH("INCOMPLETE",$E4))'], fill=PatternFill("solid",fgColor=yellow)))

# Status breakdown
dash["D10"]="Status"; dash["E10"]="Count"
for c in dash[10][3:5]:
    c.fill=PatternFill("solid",fgColor=navy); c.font=Font(color=white,bold=True)
statuses=["Passed","Failed","Blocked","Not Tested","In Progress","Retest Required","Not Applicable"]
for i,s in enumerate(statuses,11):
    dash.cell(i,4,s)
    dash.cell(i,5,f'=COUNTIF(\'QA Tracker\'!I2:I1000,D{i})')

# Priority breakdown
dash["G3"]="Priority"; dash["H3"]="Total"; dash["G3"].fill=dash["H3"].fill=PatternFill("solid",fgColor=navy)
dash["G3"].font=dash["H3"].font=Font(color=white,bold=True)
for i,p in enumerate(["P0","P1","P2"],4):
    dash.cell(i,7,p)
    dash.cell(i,8,f'=COUNTIF(\'QA Tracker\'!J2:J1000,G{i})')

# Module summary
mod_sheet = wb.create_sheet("Module Summary")
mod_sheet.sheet_view.showGridLines=False
mod_sheet.append(["Module","Total","Passed","Failed","Blocked","Not Tested","Coverage %","Pass Rate %"])
modules = ["Listing","Search","Filter","Refresh","Export","Edit","Notes","Data Accuracy","Regression"]
for m in modules:
    r=mod_sheet.max_row+1
    mod_sheet.cell(r,1,m)
    mod_sheet.cell(r,2,f'=COUNTIF(\'QA Tracker\'!B:B,A{r})')
    mod_sheet.cell(r,3,f'=COUNTIFS(\'QA Tracker\'!B:B,A{r},\'QA Tracker\'!I:I,"Passed")')
    mod_sheet.cell(r,4,f'=COUNTIFS(\'QA Tracker\'!B:B,A{r},\'QA Tracker\'!I:I,"Failed")')
    mod_sheet.cell(r,5,f'=COUNTIFS(\'QA Tracker\'!B:B,A{r},\'QA Tracker\'!I:I,"Blocked")')
    mod_sheet.cell(r,6,f'=COUNTIFS(\'QA Tracker\'!B:B,A{r},\'QA Tracker\'!I:I,"Not Tested")')
    mod_sheet.cell(r,7,f'=IFERROR((B{r}-F{r})/B{r},0)')
    mod_sheet.cell(r,8,f'=IFERROR(C{r}/(B{r}-F{r}),0)')
    mod_sheet.cell(r,7).number_format=mod_sheet.cell(r,8).number_format="0.00%"
for c in mod_sheet[1]:
    c.fill=PatternFill("solid",fgColor=navy); c.font=Font(color=white,bold=True)
mod_sheet.freeze_panes="A2"
for col,w in enumerate([20,12,12,12,12,14,14,14],1):
    mod_sheet.column_dimensions[get_column_letter(col)].width=w
mod_sheet.add_table(Table(displayName="ModuleSummary",ref=f"A1:H{mod_sheet.max_row}"))
mod_sheet.tables["ModuleSummary"].tableStyleInfo=TableStyleInfo(name="TableStyleMedium2",showRowStripes=True)

# Instructions
ins = wb.create_sheet("Instructions")
ins.sheet_view.showGridLines=False
instructions = [
    ("Purpose","Use QA Tracker to execute Properties Listing, Search, Filter, Refresh, Export, Edit, Notes, Data Accuracy and Regression scenarios."),
    ("Status","Use only the dropdown values: Not Tested, In Progress, Passed, Failed, Blocked, Not Applicable, Retest Required."),
    ("Priority","P0 = production-critical; P1 = high; P2 = lower priority."),
    ("Evidence","Paste a screenshot/file reference or test evidence location in the Evidence column."),
    ("Bug ID","Add the Jira/issue ID when a test fails or is blocked by a defect."),
    ("Coverage %","Executed / Total Test Cases."),
    ("Pass Rate %","Passed / Executed Test Cases."),
    ("Production Gate","P0 Pass must be 100%, Open P0 Bugs must be 0, and Coverage must be 100% for the dashboard to show READY FOR PRODUCTION."),
    ("Financial Accuracy","Credit Balance and Overdue Balance cases should be validated against the source of truth, not only visually."),
]
ins.append(["Item","Guidance"])
for item,guidance in instructions:
    ins.append([item,guidance])
for c in ins[1]:
    c.fill=PatternFill("solid",fgColor=navy); c.font=Font(color=white,bold=True)
ins.column_dimensions["A"].width=24
ins.column_dimensions["B"].width=110
for row in ins.iter_rows():
    for c in row:
        c.alignment=Alignment(vertical="top",wrap_text=True)
        c.border=Border(bottom=thin)

# Global calculation settings
wb.calculation = CalcProperties(calcMode="auto")

# Number formats and dashboard widths
for col,w in {"A":28,"B":18,"D":24,"E":24,"G":18,"H":18}.items():
    dash.column_dimensions[col].width=w
for row in dash.iter_rows():
    for c in row:
        c.alignment=Alignment(vertical="center",wrap_text=True)

# Add a chart
pie = PieChart()
labels = Reference(dash, min_col=4, min_row=11, max_row=17)
data = Reference(dash, min_col=5, min_row=10, max_row=17)
pie.add_data(data, titles_from_data=True)
pie.set_categories(labels)
pie.title = "Test Status Distribution"
pie.height = 7
pie.width = 10
dash.add_chart(pie, "D19")

# Make dashboard visually stronger
for cell in ["B12","B13","B17"]:
    dash[cell].font=Font(size=13,bold=True)
for row in range(4,18):
    dash.row_dimensions[row].height=22

wb.save(file_path)

file_path
