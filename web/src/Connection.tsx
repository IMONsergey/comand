import { ArrowUpRight, Check, Link2, ShieldCheck, Terminal } from 'lucide-react';
import { Copy } from './components';
import { OAuthConnections } from './OAuthConnections';
export function Connection() {
  const endpoint = `${window.location.origin}/mcp`;
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);
  const secure = window.location.protocol === 'https:';
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">РАБОТА ИЗ РАЗГОВОРА</div>
          <h1>
            Подключение<span className="title-dot">.</span>
          </h1>
          <p>
            Подключите Comand к ChatGPT или другому AI-клиенту и работайте со своими устройствами из
            чата.
          </p>
        </div>
      </div>
      <OAuthConnections />
      <div className="connection-layout">
        <section className="panel connection-main">
          <div className="panel-heading">
            <div>
              <h2>
                <Link2 size={20} />
                Адрес MCP-сервера
              </h2>
              <p>Адрес сервера для подключения клиента</p>
            </div>
            <span className="tag">OAUTH · MCP</span>
          </div>
          <div className="endpoint-box">
            <code>{endpoint}</code>
            <Copy value={endpoint} />
          </div>
          {local || !secure ? (
            <div className="notice warning">
              <strong>
                {local
                  ? 'Сейчас хаб доступен по локальному адресу.'
                  : 'Для удалённого подключения нужен HTTPS.'}
              </strong>
              <p>
                ChatGPT должен иметь доступ к публичному HTTPS-адресу хаба. Настройте reverse proxy
                или HTTPS-туннель, затем запускайте хаб с соответствующим публичным URL и
                разрешённым host.
              </p>
            </div>
          ) : (
            <div className="notice">
              <Check size={17} />
              Вы используете HTTPS-адрес. Убедитесь, что он доступен клиенту извне.
            </div>
          )}
          <div className="connection-instructions">
            <div className="setup-step">
              <span className="step-number">1</span>
              <div>
                <h3>Скопируйте адрес сервера</h3>
                <p>
                  Используйте адрес выше. Для удалённого клиента сервер должен быть доступен по
                  HTTPS. Устройства подключаются к этому же серверу через агент Comand.
                </p>
              </div>
            </div>
            <div className="setup-step">
              <span className="step-number">2</span>
              <div>
                <h3>Добавьте MCP-сервер в клиенте</h3>
                <p>
                  В настройках приложений ChatGPT создайте подключение к MCP-серверу и вставьте
                  адрес выше. Доступность этой функции зависит от вашего аккаунта.
                </p>
              </div>
            </div>
            <div className="setup-step">
              <span className="step-number">3</span>
              <div>
                <h3>Подтвердите авторизацию</h3>
                <p>
                  В открывшемся окне Comand войдите в свой аккаунт и разрешите доступ. Клиент
                  получит отдельную авторизацию для ваших устройств и проектов. Её можно отозвать в
                  списке подключённых приложений.
                </p>
              </div>
            </div>
            <div className="setup-step">
              <span className="step-number">4</span>
              <div>
                <h3>Опишите задачу</h3>
                <p>
                  Напишите, что нужно сделать. Агент сам найдёт нужный проект на подключённом
                  компьютере, изучит его и выполнит работу. Ход работы и результаты доступны в
                  Comand.
                </p>
              </div>
            </div>
          </div>
        </section>
        <aside className="connection-aside">
          <section className="panel info-card">
            <ShieldCheck size={24} />
            <h3>Контроль остаётся у вас</h3>
            <p>
              По умолчанию агент получает доступ к файлам компьютера и терминалу с правами вашего
              пользователя ОС. Ограничение файлов папкой и проверка веб-страниц — дополнительные
              настройки.
            </p>
            <p>Операции сохраняются как задачи с журналом и явным результатом.</p>
          </section>
          <section className="panel info-card">
            <Terminal size={23} />
            <h3>Другой MCP-клиент?</h3>
            <p>
              Используйте тот же адрес с поддержкой Streamable HTTP и OAuth. Войдите в Comand под
              тем же аккаунтом, к которому подключены ваши устройства.
            </p>
            <div className="technical-note">
              Подключение компьютера и подключение AI-клиента — отдельные шаги. Активный агент нужен
              для выполнения новых задач.
            </div>
          </section>
          <a
            className="text-button external-link"
            href="https://modelcontextprotocol.io/"
            target="_blank"
            rel="noreferrer"
          >
            О протоколе MCP
            <ArrowUpRight size={15} />
          </a>
        </aside>
      </div>
    </>
  );
}
