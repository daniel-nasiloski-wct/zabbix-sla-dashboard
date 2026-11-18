<?php declare(strict_types = 1);

namespace Modules\SlaDashboard;

use APP;
use CMenuItem;
use CRoleHelper;
use CWebUser;
use Modules\SlaDashboard\Includes\CI18n;
use Throwable;
use Zabbix\Core\CModule as CModuleBase;

/**
 * Módulo "SLA dashboard": acrescenta Services → SLA dashboard (logo depois de SLA report).
 * Só lê pela API com a sessão do usuário; nada é alterado no Zabbix.
 */
class Module extends CModuleBase {

	public function init(): void {
		try {
			if (!CWebUser::checkAccess(CRoleHelper::UI_SERVICES_SLA_REPORT)) {
				return;
			}

			$item = (new CMenuItem(CI18n::t('SLA dashboard')))->setAction('sladashboard.view');
			$submenu = APP::Component()->get('menu.main')->findOrAdd(_('Services'))->getSubMenu();

			if ($submenu->find(_('SLA report')) !== null) {
				$submenu->insertAfter(_('SLA report'), $item);
			}
			else {
				$submenu->add($item);
			}
		}
		catch (Throwable $e) {
			// O menu nunca pode derrubar as outras páginas do frontend.
			error_log('sla_dashboard: menu not added: '.$e->getMessage());
		}
	}
}
