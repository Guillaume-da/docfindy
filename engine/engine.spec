# PyInstaller spec — builds the docfindy-engine onefile sidecar.
# Usage: pyinstaller engine.spec
# Output: dist/docfindy-engine[.exe]

a = Analysis(
    ['main.py'],
    pathex=[],
    binaries=[],
    datas=[],
    hiddenimports=[
        'pypdf',
        'sqlite3',
    ],
    hookspath=[],
    excludes=['tkinter', 'matplotlib', 'PIL'],
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='docfindy-engine',
    debug=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
)
