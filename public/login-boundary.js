export function riYellowLoginBoundary(language = 'en', observedStatus = {}) {
  const configured = observedStatus?.configured === true
    && observedStatus?.adapter === 'RI_YELLOW_WHATSAPP_OTP_V1'
    && observedStatus?.channel === 'WHATSAPP_OTP'
    && observedStatus?.start_path === '/api/auth/ri-yellow/start'
    && observedStatus?.verify_path === '/api/auth/ri-yellow/verify'
    && observedStatus?.login_grants_business_authority === false
    && observedStatus?.public_listing_is_login_credential === false;
  return Object.freeze({
    configured,
    href: configured ? '#ri-yellow-login-dialog' : '#business-link-title',
    label: configured
      ? (language === 'vi'
        ? 'WhatsApp OTP đã sẵn sàng · không tự cấp quyền sở hữu doanh nghiệp'
        : 'WhatsApp OTP ready · does not automatically grant business ownership')
      : (language === 'vi'
        ? 'RI-YELLOW SSO/OTP đang được kết nối; listing công khai chưa phải thông tin đăng nhập'
        : 'RI-YELLOW SSO/OTP is being connected; a public listing is not a login credential'),
  });
}
