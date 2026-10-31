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
          <p>Дайте ChatGPT доступ к вашей рабочей среде через стандартный MCP.</p>
        </div>
      </div>
      <OAuthConnections />
      <div className="connection-layout">
        <section className="panel connection-main">
          <div className="panel-heading">
            <div>
              <h2>
                <Link2 size={20} />
                MCP endpoint
              </h2>
              <p>Адрес сервера для подключения клиента</p>
            </div>
            <span className="tag">STREAMABLE HTTP</span>
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
                <h3>Опубликуйте адрес хаба</h3>
                <p>
                  Используйте собственный домен с TLS или защищённый HTTPS-туннель. Укажите внешний
                  URL в настройках запуска хаба. Не передавайте токен владельца в URL.
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
                  Пройдите OAuth в окне хаба и разрешите доступ. Используйте токен владельца только
                  на странице вашего хаба. MCP-клиент получит отдельную авторизацию.
                </p>
              </div>
            </div>
            <div className="setup-step">
              <span className="step-number">4</span>
              <div>
                <h3>Начните с чтения</h3>
                <p>
                  Попросите показать подключённые устройства и проекты. Затем создайте задачу в
                  нужном проекте и проверьте её результат в Comand.
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
              Агент работает с разрешёнными папками. Команды терминала и браузер включаются отдельно
              при подключении устройства.
            </p>
            <p>Операции сохраняются как задачи с журналом и явным результатом.</p>
          </section>
          <section className="panel info-card">
            <Terminal size={23} />
            <h3>Другой MCP-клиент?</h3>
            <p>
              Используйте тот же endpoint с поддержкой Streamable HTTP и OAuth. Для доверенных
              клиентов возможна авторизация токеном владельца через заголовок Authorization.
            </p>
            <div className="technical-note">
              Bearer-токен даёт полный доступ владельца. Храните его в защищённой конфигурации
              клиента.
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
