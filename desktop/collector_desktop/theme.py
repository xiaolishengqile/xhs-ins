"""采图台的轻量原生界面样式。"""

APP_STYLE = """
QMainWindow, QWidget#appShell {
    background: #f5f7fa;
    color: #20242b;
}
QFrame#topBar {
    background: #ffffff;
    border: 1px solid #e1e6ed;
    border-radius: 10px;
}
QLabel#brandTitle {
    color: #172033;
    font-size: 20px;
    font-weight: 700;
}
QLabel#brandSubtitle, QLabel[kind="hint"] {
    color: #697386;
}
QLabel#connectionStatus {
    background: #eef6ff;
    color: #1769aa;
    border: 1px solid #cfe5fb;
    border-radius: 7px;
    padding: 7px 11px;
}
QListWidget#sideNavigation {
    background: #172033;
    color: #dce5f2;
    border: 0;
    border-radius: 10px;
    padding: 10px 7px;
    outline: 0;
    font-size: 15px;
    font-weight: 600;
}
QListWidget#sideNavigation::item {
    border-radius: 7px;
    margin: 3px 0;
    padding: 11px 13px;
}
QListWidget#sideNavigation::item:selected {
    background: #2f6feb;
    color: #ffffff;
}
QListWidget#sideNavigation::item:hover:!selected {
    background: #26344d;
}
QGroupBox {
    background: #ffffff;
    border: 1px solid #dfe4eb;
    border-radius: 10px;
    margin-top: 13px;
    padding: 12px;
    font-weight: 600;
}
QGroupBox::title {
    subcontrol-origin: margin;
    left: 14px;
    padding: 0 5px;
    color: #25324a;
}
QPushButton {
    min-height: 31px;
    padding: 0 13px;
    border: 1px solid #cfd6df;
    border-radius: 7px;
    background: #ffffff;
    color: #2c3442;
    font-weight: 600;
}
QPushButton:hover { background: #f0f4f8; }
QPushButton:pressed { background: #e7ecf2; }
QPushButton:disabled { color: #9ca6b5; background: #f3f5f7; }
QPushButton[role="primary"] {
    background: #2f6feb;
    border-color: #2f6feb;
    color: #ffffff;
}
QPushButton[role="primary"]:hover { background: #275fc8; }
QPushButton[role="secondary"] { background: #eef3f8; }
QPushButton[role="danger"] {
    background: #fff5f4;
    border-color: #f0b9b4;
    color: #b42318;
}
QPushButton[role="danger"]:hover { background: #ffe9e7; }
QLineEdit, QPlainTextEdit, QComboBox, QDateEdit {
    min-height: 30px;
    border: 1px solid #cfd6df;
    border-radius: 7px;
    background: #ffffff;
    padding: 2px 8px;
    selection-background-color: #2f6feb;
}
QLineEdit:focus, QPlainTextEdit:focus, QComboBox:focus, QDateEdit:focus {
    border: 1px solid #2f6feb;
}
QTableWidget, QListWidget:not(#sideNavigation) {
    background: #ffffff;
    alternate-background-color: #f8fafc;
    border: 1px solid #dfe4eb;
    border-radius: 8px;
    gridline-color: #e7ebf0;
}
QHeaderView::section {
    background: #eef2f6;
    color: #3a4658;
    border: 0;
    border-right: 1px solid #dfe4eb;
    border-bottom: 1px solid #dfe4eb;
    padding: 8px;
    font-weight: 700;
}
QLabel[kind="message"] {
    color: #465269;
    padding: 4px 2px;
}
"""
