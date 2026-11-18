<?php declare(strict_types = 1);

namespace Modules\SlaDashboard\Includes;

/**
 * Tradução nas regras do Zabbix: gettext no idioma do perfil do usuário (o core já fez o setlocale).
 * Primeiro o domínio "frontend" do próprio Zabbix (SLA, SLO, SLI, Uptime, Downtime, Error budget… já
 * vêm traduzidos nos 39 idiomas); o que o core não tem sai do domínio do módulo
 * (locale/<idioma>/LC_MESSAGES/sla_dashboard.mo). O JS recebe tudo pronto num dicionário.
 */
class CI18n {

	public const DOMAIN = 'sla_dashboard';

	private static bool $bound = false;

	private static function bind(): void {
		if (self::$bound) {
			return;
		}
		self::$bound = true;
		if (function_exists('bindtextdomain')) {
			bindtextdomain(self::DOMAIN, dirname(__DIR__).'/locale');
			if (function_exists('bind_textdomain_codeset')) {
				bind_textdomain_codeset(self::DOMAIN, 'UTF-8');
			}
		}
	}

	/** Texto do módulo (o inglês é a chave, como no _() do Zabbix). */
	public static function t(string $text): string {
		self::bind();

		return function_exists('dgettext') ? dgettext(self::DOMAIN, $text) : $text;
	}

	/** Core primeiro, módulo depois. */
	public static function any(string $text): string {
		$core = _($text);

		return $core !== $text ? $core : self::t($text);
	}

	/**
	 * Dicionário {inglês: traduzido} com todos os t('…') do JavaScript, lidos do próprio arquivo para a
	 * lista nunca ficar fora de sincronia com o código.
	 */
	public static function strings(): array {
		$js = @file_get_contents(dirname(__DIR__).'/assets/js/sla-dashboard.js');
		if ($js === false || !preg_match_all("/\\bt\\('((?:[^'\\\\]|\\\\.)*)'/", $js, $m)) {
			return [];
		}

		$out = [];
		foreach (array_unique($m[1]) as $text) {
			$text = stripslashes($text);
			$translated = self::any($text);
			if ($translated !== $text) {
				$out[$text] = $translated;
			}
		}

		return $out;
	}
}
