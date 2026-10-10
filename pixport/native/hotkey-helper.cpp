/*
 * hotkey-helper.exe — папка активного окна проводника для хоткея Ctrl+Alt+Q.
 *
 * Зачем: PowerShell-версия (hotkey.js) в первый раз думает 1-2 сек —
 * холодный старт .NET + компиляция Add-Type + подъём COM. Этот exe делает
 * то же самое напрямую через COM за ~0.05 сек, без зависимостей.
 *
 * Протокол: печатает в stdout одну строку JSON и завершается с кодом 0:
 *   {"path":"C:\\...","hwnd":"0x...","cls":"CabinetWClass","seen":3,
 *    "err":"","title":"...","proc":"explorer","via":"native"}
 * path пустой = активное окно не проводник (hotkey.js тогда папку не трогает).
 * Никогда не падает с ошибкой наружу: любая беда превращается в err/path="".
 *
 * Сборка:
 *   g++ -O2 -static -static-libgcc -static-libstdc++ -o hotkey-helper.exe
 *       hotkey-helper.cpp -lole32 -loleaut32 -luuid -lshell32
 * -static обязателен: exe едет к чужим людям, libstdc++-DLL у них нет.
 */

#include <windows.h>
#include <shlobj.h>
#include <exdisp.h>
#include <oleauto.h>
#include <string>
#include <vector>

// ------------------------------------------------------------- утилиты

static std::string ToUtf8(const std::wstring &w) {
    if (w.empty()) return std::string();
    int n = WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), NULL, 0, NULL, NULL);
    if (n <= 0) return std::string();
    std::string s((size_t)n, '\0');
    WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), &s[0], n, NULL, NULL);
    return s;
}

// Экранирование для JSON-строки (вход — уже UTF-8 байты).
static std::string JsonEscape(const std::string &s) {
    std::string o;
    o.reserve(s.size() + 8);
    char hex[] = "0123456789abcdef";
    for (unsigned char c : s) {
        switch (c) {
            case '\"': o += "\\\""; break;
            case '\\': o += "\\\\"; break;
            case '\n': o += "\\n"; break;
            case '\r': o += "\\r"; break;
            case '\t': o += "\\t"; break;
            default:
                if (c < 0x20) {
                    o += "\\u00";
                    o += hex[c >> 4];
                    o += hex[c & 0xF];
                } else {
                    o += (char)c;
                }
        }
    }
    return o;
}

// Читать свойство IDispatch по имени. true = получилось, результат в *out.
static bool GetProp(IDispatch *d, const wchar_t *name, VARIANT *out) {
    if (!d || !name || !out) return false;
    DISPID id = 0;
    LPOLESTR nm = const_cast<LPOLESTR>(name);
    if (FAILED(d->GetIDsOfNames(IID_NULL, &nm, 1, LOCALE_USER_DEFAULT, &id))) return false;
    DISPPARAMS dp = { NULL, NULL, 0, 0 };
    VariantInit(out);
    return SUCCEEDED(d->Invoke(id, IID_NULL, LOCALE_USER_DEFAULT, DISPATCH_PROPERTYGET, &dp, out, NULL, NULL));
}

static std::wstring BaseName(const std::wstring &p) {
    size_t i = p.find_last_of(L"\\/");
    return (i == std::wstring::npos) ? p : p.substr(i + 1);
}

// ------------------------------------------------------------- main

int main() {
    SetConsoleOutputCP(CP_UTF8);

    std::string path, cls, title, proc, err;
    char hwndBuf[32] = "0x0";
    long seen = 0;

    HWND fg = GetForegroundWindow();
    _snprintf_s(hwndBuf, sizeof(hwndBuf), _TRUNCATE, "0x%llx", (unsigned long long)(uintptr_t)fg);

    wchar_t wbuf[512] = L"";
    if (GetClassNameW(fg, wbuf, 512) > 0) cls = ToUtf8(wbuf);
    wbuf[0] = L'\0';
    if (GetWindowTextW(fg, wbuf, 512) > 0) title = ToUtf8(wbuf);

    DWORD pid = 0;
    GetWindowThreadProcessId(fg, &pid);
    if (pid > 0) {
        HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
        if (h) {
            wchar_t img[MAX_PATH * 2] = L"";
            DWORD n = (DWORD)(sizeof(img) / sizeof(img[0]));
            if (QueryFullProcessImageNameW(h, 0, img, &n)) {
                std::wstring b = BaseName(img);
                size_t dot = b.rfind(L'.');
                if (dot != std::wstring::npos) b = b.substr(0, dot);
                proc = ToUtf8(b);
            }
            CloseHandle(h);
        }
    }

    // Рабочий стол — отдельный класс, окон у Shell для него нет.
    if (cls == "Progman" || cls == "WorkerW") {
        wchar_t desk[MAX_PATH * 2] = L"";
        if (SUCCEEDED(SHGetFolderPathW(NULL, CSIDL_DESKTOP, NULL, 0, desk))) {
            path = ToUtf8(desk);
        } else {
            err = "no desktop path";
        }
    } else {
        HRESULT hr = CoInitialize(NULL);
        bool coinited = SUCCEEDED(hr);
        if (!coinited) {
            err = "CoInitialize failed";
        } else {
            IShellWindows *sw = NULL;
            hr = CoCreateInstance(CLSID_ShellWindows, NULL, CLSCTX_ALL,
                                  IID_IShellWindows, (void **)&sw);
            if (FAILED(hr) || !sw) {
                err = "ShellWindows unavailable";
            } else {
                long count = 0;
                if (SUCCEEDED(sw->get_Count(&count))) {
                    for (long i = 0; i < count; i++) {
                        VARIANT vi;
                        VariantInit(&vi);
                        vi.vt = VT_I4;
                        vi.lVal = i;
                        IDispatch *dw = NULL;
                        if (SUCCEEDED(sw->Item(vi, &dw)) && dw) {
                            seen++;
                            // HWND окна — совпало с активным?
                            VARIANT vhwnd;
                            bool match = false;
                            if (GetProp(dw, L"HWND", &vhwnd)) {
                                long long wh = 0;
                                if (vhwnd.vt == VT_I4) wh = vhwnd.lVal;
                                else if (vhwnd.vt == VT_I8) wh = vhwnd.llVal;
                                else if (vhwnd.vt == VT_UI4) wh = vhwnd.ulVal;
                                match = (wh == (long long)(intptr_t)fg);
                                VariantClear(&vhwnd);
                            }
                            if (match) {
                                // Document.Folder.Self.Path
                                VARIANT vdoc, vfold, vself, vpath;
                                if (GetProp(dw, L"Document", &vdoc) && vdoc.vt == VT_DISPATCH && vdoc.pdispVal) {
                                    if (GetProp(vdoc.pdispVal, L"Folder", &vfold) && vfold.vt == VT_DISPATCH && vfold.pdispVal) {
                                        if (GetProp(vfold.pdispVal, L"Self", &vself) && vself.vt == VT_DISPATCH && vself.pdispVal) {
                                            if (GetProp(vself.pdispVal, L"Path", &vpath)) {
                                                if (vpath.vt == VT_BSTR && vpath.bstrVal) {
                                                    path = ToUtf8(std::wstring(vpath.bstrVal, SysStringLen(vpath.bstrVal)));
                                                }
                                                VariantClear(&vpath);
                                            }
                                            VariantClear(&vself);
                                        }
                                        VariantClear(&vfold);
                                    }
                                    VariantClear(&vdoc);
                                }
                                dw->Release();
                                break; // своё окно нашли, дальше не ищем
                            }
                            dw->Release();
                        }
                        VariantClear(&vi);
                    }
                }
                sw->Release();
            }
            CoUninitialize();
        }
    }

    printf("{\"path\":\"%s\",\"hwnd\":\"%s\",\"cls\":\"%s\",\"seen\":%ld,"
           "\"err\":\"%s\",\"title\":\"%s\",\"proc\":\"%s\",\"via\":\"native\"}",
           JsonEscape(path).c_str(), hwndBuf,
           JsonEscape(cls).c_str(), seen,
           JsonEscape(err).c_str(),
           JsonEscape(title).c_str(), JsonEscape(proc).c_str());
    return 0;
}
