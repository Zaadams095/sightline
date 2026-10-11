import Constants, { ExecutionEnvironment } from 'expo-constants';

/** True inside Expo Go, where the VPN, RTSP engine and notification extension aren't available. */
export const isExpoGo = Constants.executionEnvironment === ExecutionEnvironment.StoreClient;
