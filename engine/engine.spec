# PyInstaller spec — builds the findy-engine onefile sidecar.
# Usage: pyinstaller engine.spec
# Output: dist/findy-engine[.exe]

a = Analysis(
    ['main.py'],
    pathex=[],
    binaries=[],
    datas=[],
    hiddenimports=[
        'graphify',
        'graphify.detect',
        'graphify.extract',
        'graphify.build',
        'graphify.cluster',
        'graphify.export',
        'networkx',
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
    name='findy-engine',
    debug=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
)
