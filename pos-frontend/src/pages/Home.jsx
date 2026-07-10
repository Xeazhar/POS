import React from 'react';
import BottomNav from '../components/shared/BottomNav';
import Greetings from '../components/home/Greetings';
import Minicard from '../components/home/Minicard';
import { FaMoneyBills } from "react-icons/fa6";
import { GrInProgress } from "react-icons/gr";
import RecentOrders from '../components/home/RecentOrders';
import PopularDishes from '../components/home/PopularDishes';

const Home = () => {
  return (
    <section className="bg-gray-950 h-[calc(100vh-5rem)] overflow-hidden flex gap-3">
    {/*left Side*/}  
      <div className="flex-[3]">
        <Greetings />
        <div className="flex items-center w-full gap-3 px-8 mt-8">
          <Minicard title="Total Earnings" icon={<FaMoneyBills />} number={512} footerNum={1.6} />
          <Minicard title="In Progress" icon={<GrInProgress />} number={16} footerNum={3.6} />

        </div>
        <RecentOrders />

      </div>

    {/*Right Side*/}
      <div className="flex-[2]">
        <PopularDishes />
      </div>
    <BottomNav />
    </section>
  );
};

export default Home;