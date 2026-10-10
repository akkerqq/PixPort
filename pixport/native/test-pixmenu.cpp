// Тест PixMenu.dll: создаёт COM-объект как это сделает проводник,
// читает метаданные пункта и вызывает Invoke с реальной папкой.
//
// Собрать (см. build-menu-dll):
//   g++ -o test-pixmenu.exe test-pixmenu.cpp PixMenu.def ... — нет, проще:
//   g++ -o test-pixmenu.exe test-pixmenu.cpp -static -lole32 -lshell32 -lshlwapi -luuid
// (CLSID продублирован здесь, чтобы тест был независимым от заголовка DLL)

#include <windows.h>
#include <shlobj.h>
#include <shobjidl.h>
#include <shlwapi.h>
#include <stdio.h>

static const CLSID CLSID_PixMenu =
    {0x7c3f1f5b, 0x2a44, 0x4e0a, {0x9c, 0x5d, 0x8f, 0x1e, 0x2d, 0x6b, 0x4a, 0x91}};

static int g_ok = 0, g_bad = 0;
static void check(const wchar_t *name, bool cond, const wchar_t *detail = L"") {
    wprintf(L"  %ls %ls%ls\n", cond ? L"[OK]  " : L"[FAIL]", name,
            (detail && *detail) ? L" -> " : L"", detail);
    cond ? ++g_ok : ++g_bad;
}

int wmain(int argc, wchar_t **argv) {
    HRESULT hr = CoInitializeEx(NULL, COINIT_APARTMENTTHREADED);
    if (FAILED(hr)) { wprintf(L"CoInitializeEx failed: 0x%08X\n", hr); return 1; }

    // 1. Проводник создал бы объект именно так
    IExplorerCommand *cmd = NULL;
    hr = CoCreateInstance(CLSID_PixMenu, NULL, CLSCTX_INPROC_SERVER,
                          IID_IExplorerCommand, (void **)&cmd);
    check(L"CoCreateInstance (DLL грузится)", SUCCEEDED(hr) && cmd,
          SUCCEEDED(hr) ? L"" : L"класс не найден / DLL не загрузилась");
    if (FAILED(hr)) { CoUninitialize(); return 1; }

    // 2. Заголовок пункта
    LPWSTR title = NULL;
    hr = cmd->GetTitle(NULL, &title);
    check(L"GetTitle", SUCCEEDED(hr) && title && *title, title ? title : L"(пусто)");
    if (title) wprintf(L"       текст = \"%ls\"\n", title);

    // 3. Иконка
    LPWSTR icon = NULL;
    hr = cmd->GetIcon(NULL, &icon);
    check(L"GetIcon (путь к exe)", SUCCEEDED(hr) && icon && *icon, icon ? icon : L"(пусто)");

    // 4. Состояние — должно быть включено
    EXPCMDSTATE st = (EXPCMDSTATE)-1;
    hr = cmd->GetState(NULL, TRUE, &st);
    check(L"GetState = ECS_ENABLED", SUCCEEDED(hr) && st == ECS_ENABLED,
          st == ECS_ENABLED ? L"1" : L"не ECS_ENABLED");

    // 5. Флаги — обычный пункт без подменю
    EXPCMDFLAGS fl = (EXPCMDFLAGS)-1;
    hr = cmd->GetFlags(&fl);
    check(L"GetFlags = 0 (нет подменю)", SUCCEEDED(hr) && fl == 0);

    // 6. Подменю отсутствует
    IEnumExplorerCommand *pen = NULL;
    hr = cmd->EnumSubCommands(&pen);
    check(L"EnumSubCommands = E_NOTIMPL", hr == E_NOTIMPL);
    if (pen) pen->Release();

    // 7. Invoke с реальной папкой — как будто пользователь кликнул в ПКМ
    const wchar_t *folder = (argc > 1) ? argv[1] : L"C:\\Windows\\Temp";
    IShellItem *psi = NULL;
    hr = SHCreateItemFromParsingName(folder, NULL, IID_PPV_ARGS(&psi));
    check(L"папка распознана", SUCCEEDED(hr) && psi, folder);

    IShellItemArray *psia = NULL;
    if (SUCCEEDED(hr)) hr = SHCreateShellItemArrayFromShellItem(psi, IID_PPV_ARGS(&psia));
    check(L"ShellItemArray собран", SUCCEEDED(hr) && psia);

    if (psia) {
        hr = cmd->Invoke(psia, NULL);
        check(L"Invoke (запуск PixPort.exe)", SUCCEEDED(hr),
              SUCCEEDED(hr) ? L"ShellExecute вернул > 32" : L"Invoke упал");
        psia->Release();
    }
    if (psi) psi->Release();

    if (title) CoTaskMemFree(title);
    if (icon)  CoTaskMemFree(icon);
    cmd->Release();

    // 8. DllCanUnloadNow должен разрешить выгрузку, когда ссылок нет
    // (проверяем через отдельный вызов — здесь объект уже отпущен)
    CoUninitialize();

    wprintf(L"\nИтог: %d ок, %d провалено\n", g_ok, g_bad);
    return g_bad ? 1 : 0;
}
