<script setup lang="ts">
const dialog = ref<HTMLDialogElement | null>(null)
</script>

<template>
  <button type="button" class="secondary inline-flex items-center gap-2" aria-haspopup="dialog" @click="dialog?.showModal()">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M9.6 9.2a2.5 2.5 0 0 1 4.9.5c0 1.4-2.5 1.8-2.5 3.4m0 3.7h.01" />
    </svg>
    Справка
  </button>

  <dialog ref="dialog" class="panel help-dialog" aria-labelledby="help-title">
    <header class="flex items-start justify-between gap-3">
      <h2 id="help-title" class="text-lg font-semibold">Как пользоваться Site Downloader</h2>
      <form method="dialog">
        <button type="submit" class="dialog-close" aria-label="Закрыть справку">
          <span aria-hidden="true">×</span>
        </button>
      </form>
    </header>

    <div class="mt-4 grid gap-2">
      <details class="help-topic" name="site-downloader-help" open>
        <summary>Первый захват</summary>
        <div class="help-copy">
          <ol>
            <li>Вставь адрес страницы и выбери папку для сохранения.</li>
            <li>Нажми <strong>Начать захват</strong>. По умолчанию приложение открывает до 10 страниц и ждёт ресурсы ещё 15 секунд на каждой.</li>
            <li>После захвата открой <strong>Файлы архива</strong> или нажми <strong>Запустить с JavaScript</strong>.</li>
          </ol>
          <p>В журнале видны активные файлы и ошибки. Показатель «Запись» отражает скорость сохранения на диск.</p>
        </div>
      </details>

      <details class="help-topic" name="site-downloader-help">
        <summary>Вход и фильтры</summary>
        <div class="help-copy">
          <p>Для закрытой страницы включи <strong>Скачать после входа</strong>, войди в окне Chromium и нажми <strong>Я вошёл, начать захват</strong>.</p>
          <p>Чтобы обойти только нужные разделы, раскрой <strong>Фильтры обхода</strong> и введи по одному пути на строку, например <code>/docs</code>. Стартовая страница открывается в любом случае.</p>
        </div>
      </details>

      <details class="help-topic" name="site-downloader-help">
        <summary>Открыть скачанный сайт</summary>
        <div class="help-copy">
          <p>Нажми <strong>Выбрать папку архива…</strong> и выбери папку с <code>manifest.json</code>.</p>
          <ul>
            <li><strong>Запустить с JavaScript</strong> открывает интерактивную копию. Адрес <code>site-downloader.localhost</code> работает в окне Chromium, которое открыл Site Downloader.</li>
            <li><strong>Открыть HTML-снимок</strong> открывает файл с диска. Скрипты в снимке отключены.</li>
          </ul>
        </div>
      </details>

      <details class="help-topic" name="site-downloader-help">
        <summary>Файлы, JavaScript и шейдеры</summary>
        <div class="help-copy">
          <p>В <strong>Файлах архива</strong> можно искать по имени, пути или домену и переключаться между HTML, CSS, JavaScript, картинками и 3D.</p>
          <p>Выбери JS-файл и нажми <strong>Разобрать JavaScript</strong>. В читаемом коде можно искать функции. Во вкладке <strong>Шейдеры GLSL</strong> блок «Связанный JavaScript» ведёт к месту подключения шейдера.</p>
        </div>
      </details>

      <details class="help-topic" name="site-downloader-help">
        <summary>Модели и текстуры</summary>
        <div class="help-copy">
          <p>Включи <strong>Ручной захват 3D-сцены</strong>. Открой сцену, переключи нужные объекты в Chromium и нажми <strong>Завершить захват сцены</strong>.</p>
          <p>Кнопка <strong>Открыть 3D-файлы</strong> покажет модели, текстуры и зависимости, которые удалось сохранить.</p>
        </div>
      </details>

      <details class="help-topic" name="site-downloader-help">
        <summary>Если сайт открылся не полностью</summary>
        <div class="help-copy">
          <p>Если браузер показывает <code>file://</code> и скрипты не работают, вернись в приложение и нажми <strong>Запустить с JavaScript</strong>.</p>
          <p>Проверь список <strong>Не хватило ресурсов</strong>. Если там есть нужный файл, увеличь ожидание или повтори захват в ручном 3D-режиме. Если скрипту нужен исходный домен, включи <strong>Использовать исходный адрес</strong>.</p>
        </div>
      </details>
    </div>
  </dialog>
</template>
