# PixPort

<img src="pixport/assets/icon.png" width="96" alt="PixPort">

Фото с телефона — сразу в нужную папку на ПК. Без проводов, мессенджеров и облаков.

**Как это работает:**
1. Выбери папку — кнопкой, перетаскиванием в окно, правым кликом в проводнике или хоткеем **Ctrl+Alt+Q** в открытой папке.
2. Наведи камеру телефона на QR-код.
3. Сними фото или выбери из галереи — оно сразу окажется в папке на компьютере.

Закрытие окна сворачивает программу в трей — хоткей продолжает работать. QR-код живёт 30 минут.

## Скачать

Windows: **[Latest release](https://github.com/akkerqq/PixPort/releases/latest)** → `PixPort-Setup-*.exe`.
Приложение само проверяет обновления: ⚙ Настройки → Обновления → Проверить.

## Бесплатно и Pro

|  | Free | Pro |
|---|---|---|
| Качество фото | до 960 px со сжатием | оригинал без ограничений |
| Файлы и видео | только фото | что угодно, до 512 МБ, как есть |
| Цена | — | разовый ключ |

Ключ вводится в ⚙ Настройки → Подписка.

## Требования

- Телефон и компьютер в **одном Wi-Fi**.
- Телефон не открывает страницу? Разреши PixPort в брандмауэре Windows (порт 8765). Команда для терминала:
  ```powershell
  netsh advfirewall firewall add rule name="PixPort" dir=in action=allow protocol=TCP localport=8765
  ```

## Для разработчиков

```powershell
cd pixport
npm install
npm start                # приложение (Electron)
node server.js "C:\папка" # только сервер
node test.js "C:\папка"   # тесты
npm run dist             # сборка инсталлера (требует Inno Setup 6)
```

Лицензия: MIT.

---

*EN: PixPort drops photos from your phone straight into a PC folder over local Wi-Fi — scan the QR, shoot, done. Free tier caps at 960 px compressed, Pro key unlocks originals. Windows download under Releases.*
