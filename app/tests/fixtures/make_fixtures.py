"""生成导入解析的测试样本。

为什么把样本做成脚本：
- xls（BIFF8）与 xlsx（zip）都是二进制，直接读断言需要真实文件；
- 样本必须可复现，评审时能自己重跑一遍，确认"测试通过"不是靠手工拼的假数据。

依赖（仅生成样本时需要，运行时零依赖）：
    python -m pip install openpyxl xlwt

用法：
    python tests/fixtures/make_fixtures.py
"""

import os
from datetime import date

import xlwt
from openpyxl import Workbook

HERE = os.path.dirname(os.path.abspath(__file__))


def products_xlsx():
    """产品主数据：第 1 行是标题（模拟真实报表），表头在第 2 行。"""
    wb = Workbook()
    ws = wb.active
    ws.title = "产品"
    ws["A1"] = "产品主数据（2026 版）"
    ws["A2"], ws["B2"], ws["C2"] = "产品编号", "产品名称", "单位"
    ws.append(["P-T1", "测试泵体", "台"])
    ws.append(["P-T2", "测试机架", "台"])
    ws.append(["P-T3", "测试控制柜", "套"])
    ws2 = wb.create_sheet("说明")
    ws2["A1"] = "此表只用于自动化测试，请勿作为业务数据"
    wb.save(os.path.join(HERE, "products.xlsx"))


def products_en_xlsx():
    """英文列名（ERP 导出常见）：验证表头别名。"""
    wb = Workbook()
    ws = wb.active
    ws.title = "Item Master"
    ws.append(["Item Code", "Name", "UOM"])
    ws.append(["P-T9", "英文列名产品", "台"])
    wb.save(os.path.join(HERE, "products-en.xlsx"))


def sales_orders_xlsx():
    """销售订单行：交期写成真正的日期单元格（序列号），验证日期还原。"""
    wb = Workbook()
    ws = wb.active
    ws.title = "销售订单行"
    ws.append(["销售订单行号", "客户名称", "产品编号", "数量", "客户要求完工日", "订单优先级"])
    ws.append(["SO-T1-L1", "测试客户甲", "P-T1", 40, date(2026, 12, 10), 1])
    ws.append(["SO-T1-L2", "测试客户甲", "P-T2", 12, date(2026, 12, 18), 2])
    wb.save(os.path.join(HERE, "sales-orders.xlsx"))


def production_orders_xls():
    """生产订单：旧版 xls（BIFF8），验证 OLE2 + 共享字符串表解析。"""
    wb = xlwt.Workbook(encoding="utf-8")
    ws = wb.add_sheet("生产订单")
    header = ["生产订单号", "销售订单行号", "生产数量", "人工优先级"]
    for c, text in enumerate(header):
        ws.write(0, c, text)
    rows = [
        ("PO-T1-001", "SO-T1-L1", 40, 3),
        ("PO-T2-001", "SO-T1-L2", 12, 3),
    ]
    for r, row in enumerate(rows, start=1):
        for c, val in enumerate(row):
            ws.write(r, c, val)
    wb.save(os.path.join(HERE, "production-orders.xls"))


def production_orders_solo_xlsx():
    """生产订单（无销售行，只带产品编号与交期）：验证"单独导入生产订单"的补行逻辑。"""
    wb = Workbook()
    ws = wb.active
    ws.title = "生产订单"
    ws.append(["生产订单号", "产品编号", "生产数量", "客户要求完工日"])
    ws.append(["PO-S1-001", "P-T1", 20, date(2026, 12, 15)])
    wb.save(os.path.join(HERE, "production-orders-solo.xlsx"))


def inventory_gbk_csv():
    """GBK 编码 + 制表符分隔（中文 Excel 默认另存格式），验证编码与分隔符嗅探。"""
    text = "物料编号\t数量\t仓库\nM-T1\t1000\t主仓\nM-T2\t200\t主仓\n"
    with open(os.path.join(HERE, "inventory-gbk.csv"), "wb") as f:
        f.write(text.encode("gbk"))


def products_long_xls():
    """大表 + 长中文串：把共享字符串表撑过 8KB，触发 SST 的 CONTINUE 分块。

    这是 xls 解析最容易出错的分支（跨记录时编码标志会重置），必须留回归样本。
    """
    wb = xlwt.Workbook(encoding="utf-8")
    ws = wb.add_sheet("产品")
    for c, text in enumerate(["产品编号", "产品名称", "单位"]):
        ws.write(0, c, text)
    for i in range(1, 601):
        ws.write(i, 0, "P-L%03d" % i)
        ws.write(i, 1, "超长产品名称第%03d号" % i + "·规格说明" * 6)
        ws.write(i, 2, "台")
    wb.add_sheet("说明").write(0, 0, "第二个工作表不应被当成主表")
    wb.save(os.path.join(HERE, "products-long.xls"))


def _raw_xlsx(path, sheet_xml, shared_xml=None, sheet_name="Sheet1"):
    """手工拼一个最小 xlsx（zip），用于构造 openpyxl 写不出来的"非常规写法"。

    真实世界里确实存在这类文件：带命名空间前缀（<x:row>）、属性用单引号。
    它们本身是合法 XML，但如果解析器写死了双引号 / 无前缀，整张表会被读成 0 行，
    用户看到的就是"行数 0、场景待指定、没有识别到表头"。
    """
    import zipfile

    wb = (
        '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'
        '<sheet name="%s" sheetId="1" r:id="rId1"/></sheets></workbook>' % sheet_name
    )
    rels = (
        '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>'
    )
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("xl/workbook.xml", wb)
        z.writestr("xl/_rels/workbook.xml.rels", rels)
        if shared_xml:
            z.writestr("xl/sharedStrings.xml", shared_xml)
        z.writestr("xl/worksheets/sheet1.xml", sheet_xml)


def sales_orders_prefixed_xlsx():
    """命名空间前缀 + 单引号属性 + 带单位的表头。

    三个点同时覆盖：解析层能否读到内容、表头归一化能否去掉"（件）"这类说明。
    """
    header = ["销售订单行号", "客户名称（全称）", "产品编号(必填)", "数量（件）", "客户要求完工日"]
    rows = [
        ["SO-P1-L1", "前缀客户甲", "P-T1", "30", "2026-12-20"],
        ["SO-P1-L2", "前缀客户甲", "P-T2", "10", "2026-12-22"],
    ]
    body = []
    for i, row in enumerate([header] + rows, start=1):
        cells = "".join(
            "<x:c r='%s%d' t='inlineStr'><x:is><x:t>%s</x:t></x:is></x:c>" % ("ABCDE"[j], i, v)
            for j, v in enumerate(row)
        )
        body.append("<x:row r='%d'>%s</x:row>" % (i, cells))
    sheet = (
        '<?xml version="1.0"?><x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        "<x:sheetData>%s</x:sheetData></x:worksheet>" % "".join(body)
    )
    _raw_xlsx(os.path.join(HERE, "sales-orders-prefixed.xlsx"), sheet, sheet_name="Sheet1")


def unknown_headers_xlsx():
    """表头全是"通用词"，任何场景都不该硬猜：验证识别失败时给出的提示是否可操作。"""
    wb = Workbook()
    ws = wb.active
    ws.title = "Sheet1"
    ws.append(["编号", "名称", "备注"])
    ws.append(["X-1", "某东西", "说明"])
    wb.save(os.path.join(HERE, "unknown-headers.xlsx"))


def empty_sheet_xlsx():
    """空工作表：验证"解析到 0 行"和"没有表头"能被区分开。"""
    sheet = (
        '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        "<sheetData/></worksheet>"
    )
    _raw_xlsx(os.path.join(HERE, "empty-sheet.xlsx"), sheet, sheet_name="Sheet1")


if __name__ == "__main__":
    products_xlsx()
    products_en_xlsx()
    sales_orders_xlsx()
    production_orders_xls()
    production_orders_solo_xlsx()
    inventory_gbk_csv()
    products_long_xls()
    sales_orders_prefixed_xlsx()
    unknown_headers_xlsx()
    empty_sheet_xlsx()
    print("fixtures written to", HERE)
