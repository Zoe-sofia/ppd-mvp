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


if __name__ == "__main__":
    products_xlsx()
    products_en_xlsx()
    sales_orders_xlsx()
    production_orders_xls()
    production_orders_solo_xlsx()
    inventory_gbk_csv()
    products_long_xls()
    print("fixtures written to", HERE)
