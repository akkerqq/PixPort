/*
 * PixMenu.dll — обработчик контекстного меню для Windows 11 (первый уровень).
 *
 * Зачем: Windows 11 прятает классические пункты (Directory\shell) под
 * «Показать дополнительные параметры». Чтобы пункт был на первом клике ПКМ,
 * нужен COM-обработчик IExplorerCommand. Это он.
 *
 * Регистрация (без прав админа, в HKCU):
 *   HKCU\Software\Classes\Directory\shell\PixPort
 *        ExplorerCommandHandler = {CLSID}
 *   HKCU\Software\Classes\CLSID\{CLSID}\InProcServer32
 *        (Default) = <путь к PixMenu.dll>, ThreadingModel = Apartment
 *   HKCU\Software\PixPort\ExePath = <путь к PixPort.exe>   ← откуда брать exe
 *
 * Сборка (см. build-menu-dll.sh / build.js):
 *   g++ -shared -o PixMenu.dll PixMenu.cpp -static -static-libgcc -static-libstdc++ ...
 *   -static обязателен: DLL лезет в проводник, там нельзя тянуть libstdc++.
 */

#include <windows.h>
#include <shlobj.h>
#include <shobjidl.h>
#include <shlwapi.h>
#include <string>
#include <new>

// Фиксированный CLSID. Он же в menu.js — менять строго в двух местах.
// {7C3F1F5B-2A44-4E0A-9C5D-8F1E2D6B4A91}
static const CLSID CLSID_PixMenu =
    {0x7c3f1f5b, 0x2a44, 0x4e0a, {0x9c, 0x5d, 0x8f, 0x1e, 0x2d, 0x6b, 0x4a, 0x91}};

static volatile LONG g_cRef = 0;
static HINSTANCE    g_hInst = NULL;

// ------------------------------------------------------------- утилиты

// Путь к PixPort.exe из реестра (туда его пишет кнопка установки).
static std::wstring ReadExePath() {
    wchar_t buf[MAX_PATH * 2] = L"";
    HKEY k = NULL;
    if (RegOpenKeyExW(HKEY_CURRENT_USER, L"Software\\PixPort", 0, KEY_READ, &k) == ERROR_SUCCESS) {
        DWORD type = 0, cb = sizeof(buf);
        RegQueryValueExW(k, L"ExePath", NULL, &type, (LPBYTE)buf, &cb);
        RegCloseKey(k);
    }
    return std::wstring(buf);
}

// Папка из выбранного элемента (или из фона папки).
static std::wstring FolderFromItems(IShellItemArray *psia) {
    if (!psia) return std::wstring();
    DWORD n = 0;
    if (FAILED(psia->GetCount(&n)) || n == 0) return std::wstring();
    IShellItem *psi = NULL;
    if (FAILED(psia->GetItemAt(0, &psi))) return std::wstring();
    std::wstring out;
    LPWSTR p = NULL;
    if (SUCCEEDED(psi->GetDisplayName(SIGDN_FILESYSPATH, &p)) && p) {
        out = p;
        CoTaskMemFree(p);
    }
    psi->Release();
    return out;
}

// ------------------------------------------------- реализация IExplorerCommand

class PixCommand : public IExplorerCommand {
public:
    PixCommand() : m_cRef(1) { InterlockedIncrement(&g_cRef); }
    virtual ~PixCommand() { InterlockedDecrement(&g_cRef); }

    // IUnknown
    IFACEMETHODIMP QueryInterface(REFIID riid, void **ppv) {
        if (!ppv) return E_POINTER;
        if (riid == IID_IUnknown || riid == IID_IExplorerCommand) {
            *ppv = static_cast<IExplorerCommand *>(this);
            AddRef();
            return S_OK;
        }
        *ppv = NULL;
        return E_NOINTERFACE;
    }
    IFACEMETHODIMP_(ULONG) AddRef() { return InterlockedIncrement(&m_cRef); }
    IFACEMETHODIMP_(ULONG) Release() {
        ULONG c = InterlockedDecrement(&m_cRef);
        if (!c) delete this;
        return c;
    }

    // Заголовок пункта в меню
    IFACEMETHODIMP GetTitle(IShellItemArray *, LPWSTR *ppszName) {
        if (!ppszName) return E_POINTER;
        return SHStrDupW(L"PixPort \x2014 \x041F\x043E\x043A\x0430\x0437\x0430\x0442\x044C QR", ppszName);
        // «PixPort — Показать QR» записана \x-escape, чтобы не зависеть
        // от кодировки исходника при разной локали компилятора.
    }

    // Иконка: берём из самого PixPort.exe
    IFACEMETHODIMP GetIcon(IShellItemArray *, LPWSTR *ppszIcon) {
        if (!ppszIcon) return E_POINTER;
        std::wstring exe = ReadExePath();
        if (exe.empty()) { *ppszIcon = NULL; return S_FALSE; }
        return SHStrDupW(exe.c_str(), ppszIcon);
    }

    IFACEMETHODIMP GetToolTip(IShellItemArray *, LPWSTR *ppszInfoTip) {
        if (!ppszInfoTip) return E_POINTER;
        *ppszInfoTip = NULL;
        return S_FALSE;
    }

    IFACEMETHODIMP GetCanonicalName(GUID *pguid) {
        if (!pguid) return E_POINTER;
        *pguid = CLSID_PixMenu;
        return S_OK;
    }

    // ECS_ENABLED = 1 — пункт активен всегда.
    // fOkToBeSlow — Explorer спрашивает, можно ли дорого считать; нам всегда можно.
    IFACEMETHODIMP GetState(IShellItemArray *, BOOL /*fOkToBeSlow*/, EXPCMDSTATE *pState) {
        if (!pState) return E_POINTER;
        *pState = ECS_ENABLED;
        return S_OK;
    }

    // Клик — запускаем PixPort.exe с путём папки.
    // Если PixPort уже открыт, его single-instance сам подхватит папку.
    IFACEMETHODIMP Invoke(IShellItemArray *psia, IBindCtx *) {
        std::wstring exe = ReadExePath();
        if (exe.empty() || GetFileAttributesW(exe.c_str()) == INVALID_FILE_ATTRIBUTES)
            return E_FAIL;

        std::wstring folder = FolderFromItems(psia);
        std::wstring params;
        if (!folder.empty()) params = L"\"" + folder + L"\"";

        ShellExecuteW(NULL, L"open", exe.c_str(),
                      params.empty() ? NULL : params.c_str(), NULL, SW_SHOWNORMAL);
        return S_OK;
    }

    // 0 = обычный пункт, без подменю
    IFACEMETHODIMP GetFlags(EXPCMDFLAGS *pFlags) {
        if (!pFlags) return E_POINTER;
        *pFlags = static_cast<EXPCMDFLAGS>(0);
        return S_OK;
    }

    IFACEMETHODIMP EnumSubCommands(IEnumExplorerCommand **) { return E_NOTIMPL; }

private:
    LONG m_cRef;
};

// ------------------------------------------------------- фабрика классов

class PixFactory : public IClassFactory {
public:
    PixFactory() : m_cRef(1) { InterlockedIncrement(&g_cRef); }
    virtual ~PixFactory() { InterlockedDecrement(&g_cRef); }

    IFACEMETHODIMP QueryInterface(REFIID riid, void **ppv) {
        if (!ppv) return E_POINTER;
        if (riid == IID_IUnknown || riid == IID_IClassFactory) {
            *ppv = static_cast<IClassFactory *>(this);
            AddRef();
            return S_OK;
        }
        *ppv = NULL;
        return E_NOINTERFACE;
    }
    IFACEMETHODIMP_(ULONG) AddRef() { return InterlockedIncrement(&m_cRef); }
    IFACEMETHODIMP_(ULONG) Release() {
        ULONG c = InterlockedDecrement(&m_cRef);
        if (!c) delete this;
        return c;
    }

    IFACEMETHODIMP CreateInstance(IUnknown *pUnkOuter, REFIID riid, void **ppv) {
        if (pUnkOuter) return CLASS_E_NOAGGREGATION;
        PixCommand *p = new (std::nothrow) PixCommand();
        if (!p) return E_OUTOFMEMORY;
        HRESULT hr = p->QueryInterface(riid, ppv);
        p->Release();
        return hr;
    }
    IFACEMETHODIMP LockServer(BOOL) { return S_OK; }

private:
    LONG m_cRef;
};

// ------------------------------------------------------------- экспорты

// Диагностика: пишем в лог каждый факт загрузки DLL.
// Нужно ровно для одного вопроса — открывает ли Explorer нашу библиотеку
// при вызове ПКМ. Если в логе пусто, Explorer до DllMain не дошёл.
static void TraceLoad() {
    wchar_t tmp[MAX_PATH];
    DWORD n = GetTempPathW(MAX_PATH, tmp);
    if (!n || n >= MAX_PATH) return;
    wcscat_s(tmp, MAX_PATH, L"pixmenu-load.log");

    // убираем из пути подсистемы, если есть — не важно для лога
    SYSTEMTIME st;
    GetLocalTime(&st);
    char line[512];
    char proc[260] = "?";
    GetModuleFileNameA(NULL, proc, sizeof(proc));
    int len = sprintf_s(line, sizeof(line),
        "%04d-%02d-%02dT%02d:%02d:%02d  LOAD  from=%s  tid=%lu\r\n",
        st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond,
        proc, GetCurrentThreadId());

    HANDLE f = CreateFileW(tmp, FILE_APPEND_DATA, FILE_SHARE_READ, NULL,
                           OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (f == INVALID_HANDLE_VALUE) return;
    DWORD w = 0;
    WriteFile(f, line, (DWORD)len, &w, NULL);
    CloseHandle(f);
}

extern "C" BOOL WINAPI DllMain(HINSTANCE h, DWORD reason, LPVOID) {
    if (reason == DLL_PROCESS_ATTACH) {
        g_hInst = h;
        DisableThreadLibraryCalls(h);
        TraceLoad();   // если сюда дошли — Explorer библиотеку открыл
    }
    return TRUE;
}

extern "C" HRESULT WINAPI DllGetClassObject(REFCLSID rclsid, REFIID riid, LPVOID *ppv) {
    if (!ppv) return E_POINTER;
    *ppv = NULL;
    if (rclsid != CLSID_PixMenu) return CLASS_E_CLASSNOTAVAILABLE;
    PixFactory *f = new (std::nothrow) PixFactory();
    if (!f) return E_OUTOFMEMORY;
    HRESULT hr = f->QueryInterface(riid, ppv);
    f->Release();
    return hr;
}

extern "C" HRESULT WINAPI DllCanUnloadNow() {
    return (g_cRef == 0) ? S_OK : S_FALSE;
}

// Регистрация через regsvr32 не используется (права админа),
// но экспорт нужен, чтобы regsvr32 не ругался при случайном вызове.
extern "C" HRESULT WINAPI DllRegisterServer()   { return E_NOTIMPL; }
extern "C" HRESULT WINAPI DllUnregisterServer() { return E_NOTIMPL; }
